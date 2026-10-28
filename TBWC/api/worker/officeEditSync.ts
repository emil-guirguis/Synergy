/**
 * Excel Online edit sessions — the glue between a `public.document` row (bytes
 * in the record-docs bucket) and a SharePoint driveItem Graph can serve to
 * Excel for the web. See msGraph.ts for the Graph calls and
 * migrations/122-office-edit-session.sql for the table.
 *
 * Flow: open() pushes the bucket's bytes up to SharePoint, mints an anonymous
 * edit link, and subscribes to change notifications. Every save in Excel
 * Online fires a notification to routes/officeEditWebhook.ts, which calls
 * pullBack() to copy the new bytes back down into the bucket. The bucket
 * stays the system of record — SharePoint only ever holds a working copy.
 */
import { Env, execQuery } from './db';
import {
  createAnonymousEditLink,
  createChangeSubscription,
  downloadEditCopy,
  renewChangeSubscription,
  uploadEditCopy,
} from './msGraph';
import { putObject, signObjectUrl } from './storageAdmin';

const RECORD_DOCS_BUCKET = 'record-docs';

export interface EditableDocument {
  document_id: number;
  file_name: string;
  mime_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
}

export interface OfficeEditSessionRow {
  office_edit_session_id: number;
  document_id: number;
  drive_id: string;
  item_id: string;
  subscription_id: string | null;
  client_state: string;
  last_etag: string | null;
}

/** Excel Online can only open the OOXML format; a legacy .xls has to be converted first. */
export const OFFICE_EDIT_EXTENSIONS = ['.xlsx', '.xlsm'] as const;

export function isOfficeEditable(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return OFFICE_EDIT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

async function fetchBucketBytes(env: Env, bucket: string, path: string): Promise<ArrayBuffer> {
  // 60s is plenty — the URL is used immediately, by this Worker, and never handed out.
  const url = await signObjectUrl(env, bucket, path, 60);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Reading ${bucket}/${path} failed: ${res.status}`);
  return res.arrayBuffer();
}

/**
 * Opens (or re-opens) an edit session and returns the URL to send the browser to.
 *
 * Re-opening always re-uploads the bucket's current bytes: the SharePoint copy
 * is a cache, and the document may have been replaced through the normal upload
 * path since the last edit.
 */
export async function openEditSession(env: Env, doc: EditableDocument, userId: string | null): Promise<string> {
  const bucket = doc.storage_bucket || RECORD_DOCS_BUCKET;
  if (!doc.storage_path) throw new Error('Document has no stored file');

  const bytes = await fetchBucketBytes(env, bucket, doc.storage_path);
  const contentType = doc.mime_type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const item = await uploadEditCopy(env, doc.document_id, doc.file_name, bytes, contentType);

  const { rows } = await execQuery(
    env,
    `SELECT office_edit_session_id, subscription_id, client_state
       FROM public.office_edit_session WHERE document_id = $1`,
    [doc.document_id],
    'officeEditSync.existingSession'
  );
  const existing = rows[0] as { subscription_id: string | null; client_state: string } | undefined;
  const clientState = existing?.client_state ?? crypto.randomUUID();

  // The uploaded eTag is recorded as last_etag so the save-notification Graph
  // fires for our own upload doesn't immediately pull the same bytes back down.
  let subscriptionId = existing?.subscription_id ?? null;
  let expiresAt: string | null = null;
  if (!subscriptionId) {
    const sub = await createChangeSubscription(env, item.parentReference.driveId, item.id, clientState);
    subscriptionId = sub.id;
    expiresAt = sub.expirationDateTime;
  }

  await execQuery(
    env,
    `INSERT INTO public.office_edit_session
       (document_id, drive_id, item_id, subscription_id, subscription_expires_at, client_state, last_etag, opened_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (document_id) DO UPDATE SET
       drive_id = EXCLUDED.drive_id,
       item_id = EXCLUDED.item_id,
       subscription_id = COALESCE(public.office_edit_session.subscription_id, EXCLUDED.subscription_id),
       subscription_expires_at = COALESCE(EXCLUDED.subscription_expires_at, public.office_edit_session.subscription_expires_at),
       last_etag = EXCLUDED.last_etag,
       opened_by = EXCLUDED.opened_by,
       updated_at = now()`,
    [doc.document_id, item.parentReference.driveId, item.id, subscriptionId, expiresAt, clientState, item.eTag, userId],
    'officeEditSync.upsertSession'
  );

  return createAnonymousEditLink(env, item.parentReference.driveId, item.id);
}

/** The session a change notification names, or null when clientState doesn't match. */
export async function sessionForNotification(
  env: Env,
  subscriptionId: string,
  clientState: string
): Promise<OfficeEditSessionRow | null> {
  const { rows } = await execQuery(
    env,
    `SELECT office_edit_session_id, document_id, drive_id, item_id, subscription_id, client_state, last_etag
       FROM public.office_edit_session WHERE subscription_id = $1`,
    [subscriptionId],
    'officeEditSync.sessionForNotification'
  );
  const row = rows[0] as OfficeEditSessionRow | undefined;
  if (!row || row.client_state !== clientState) return null;
  return row;
}

/**
 * Copies the current SharePoint bytes back into the bucket. A notification whose
 * eTag already matches what we last wrote is a no-op — Graph also notifies on
 * metadata touches, and rewriting identical bytes would churn the document row's
 * updated_at for every one of them.
 */
export async function pullBack(env: Env, session: OfficeEditSessionRow): Promise<boolean> {
  const { bytes, eTag, contentType } = await downloadEditCopy(env, session.drive_id, session.item_id);
  if (eTag && eTag === session.last_etag) return false;

  const { rows } = await execQuery(
    env,
    `SELECT storage_bucket, storage_path FROM public.document WHERE document_id = $1`,
    [session.document_id],
    'officeEditSync.documentForPullBack'
  );
  const doc = rows[0] as { storage_bucket: string | null; storage_path: string | null } | undefined;
  if (!doc?.storage_path) return false;

  await putObject(env, doc.storage_bucket || RECORD_DOCS_BUCKET, doc.storage_path, new Uint8Array(bytes), contentType);
  await execQuery(
    env,
    `UPDATE public.document SET file_size = $2, updated_at = now() WHERE document_id = $1`,
    [session.document_id, bytes.byteLength],
    'officeEditSync.touchDocument'
  );
  await execQuery(
    env,
    `UPDATE public.office_edit_session SET last_etag = $2, updated_at = now() WHERE office_edit_session_id = $1`,
    [session.office_edit_session_id, eTag],
    'officeEditSync.recordEtag'
  );
  return true;
}

/**
 * Daily cron (jobRegistry). Renews every subscription inside its expiry window;
 * one that Graph has already dropped is cleared so the next open() re-subscribes
 * instead of reusing a dead id.
 */
export async function renewOfficeEditSubscriptions(env: Env): Promise<Record<string, unknown>> {
  const { rows } = await execQuery(
    env,
    `SELECT office_edit_session_id, subscription_id
       FROM public.office_edit_session
      WHERE subscription_id IS NOT NULL
        AND (subscription_expires_at IS NULL OR subscription_expires_at < now() + interval '2 days')`,
    [],
    'officeEditSync.dueForRenewal'
  );

  let renewed = 0;
  let dropped = 0;
  for (const row of rows as { office_edit_session_id: number; subscription_id: string }[]) {
    try {
      const sub = await renewChangeSubscription(env, row.subscription_id);
      await execQuery(
        env,
        `UPDATE public.office_edit_session SET subscription_expires_at = $2, updated_at = now()
          WHERE office_edit_session_id = $1`,
        [row.office_edit_session_id, sub.expirationDateTime],
        'officeEditSync.renewed'
      );
      renewed++;
    } catch (e) {
      console.error('[officeEditSync] renewal failed:', e instanceof Error ? e.message : e);
      await execQuery(
        env,
        `UPDATE public.office_edit_session SET subscription_id = NULL, subscription_expires_at = NULL, updated_at = now()
          WHERE office_edit_session_id = $1`,
        [row.office_edit_session_id],
        'officeEditSync.dropDeadSubscription'
      );
      dropped++;
    }
  }
  return { considered: rows.length, renewed, dropped };
}
