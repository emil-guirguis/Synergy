/**
 * Shared types for the per-record documents grid. Mirrors the backend half in
 * framework/backend/api/base/documents.ts — keep DOC_TYPES in sync with that
 * list AND with the doc_type CHECK constraint in framework/backend/db/document.sql.
 */

export const DOC_TYPES = [
  'cutsheet',
  'invoice',
  'order',
  'packing_slip',
  'proof_of_delivery',
  'shipping',
  'email',
  'design',
  'load_schedule',
  'quote',
  'rma',
  'shipping_images',
  'change_order',
  'waiver',
  'panelboard_schedules',
  'build_of_materials',
  'credit_memo',
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DEFAULT_DOC_TYPE: DocType = 'other';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  cutsheet: 'Cutsheet',
  invoice: 'Invoice',
  order: 'Purchase Order',
  packing_slip: 'Packing Slip',
  proof_of_delivery: 'Proof of Delivery',
  shipping: 'Shipping',
  email: 'Email',
  design: 'Design',
  load_schedule: 'Load Schedule',
  quote: 'Quote',
  rma: 'RMA',
  shipping_images: 'Shipping Images',
  change_order: 'Change Order',
  waiver: 'Waiver',
  panelboard_schedules: 'Panelboard Schedules',
  build_of_materials: 'Build of Materials',
  credit_memo: 'Credit Memo',
  other: 'Other',
};

/** A document row as the API returns it (snake_case, straight from the table). */
export interface DocumentRecord {
  document_id: number;
  entity_type: string;
  entity_id: string;
  description: string | null;
  doc_type: DocType;
  file_name: string;
  mime_type: string | null;
  file_size: number | null;
  storage_bucket: string | null;
  storage_path: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateDocumentPayload {
  entityType: string;
  entityId: string;
  fileName: string;
  storageBucket: string;
  storagePath: string;
  description?: string | null;
  docType?: DocType;
  mimeType?: string | null;
  fileSize?: number | null;
}

/** What the sender typed in the email dialog. To is never defaulted for them. */
export interface EmailDocumentInput {
  /** One address, or several separated by commas/semicolons. */
  to: string;
  subject?: string;
  message?: string;
}

/** Metadata CRUD against the app's own API (the Worker), never the bucket. */
export interface DocumentsApi {
  list(entityType: string, entityId: string): Promise<DocumentRecord[]>;
  create(payload: CreateDocumentPayload): Promise<DocumentRecord>;
  update(documentId: number, patch: { description?: string; docType?: DocType }): Promise<DocumentRecord>;
  remove(documentId: number): Promise<void>;
  /**
   * Sends the file as an attachment from the server, returning the addresses it
   * went to. The bytes never reach the browser: no download for the sender to
   * clean up, and the attachment cannot go missing.
   */
  email(documentId: number, input: EmailDocumentInput): Promise<string[]>;
}

/** What really sits in the bucket at a path: `missing` is confirmed absent, `unknown` couldn't tell. */
export type StoredObjectStat = { status: 'found'; size: number | null } | { status: 'missing' } | { status: 'unknown' };

/**
 * The bytes half. Implemented today by createWorkerDocumentStorage (the app's
 * Worker authorizes and signs; bytes go browser ↔ storage direct); a DB-blob or
 * R2 implementation can be dropped in without the grid noticing.
 */
export interface DocumentStorage {
  bucket: string;
  /**
   * `signal` lets a caller put a deadline on the transfer. A bulk importer
   * uploading hundreds of files cannot let one stalled POST hang the whole run
   * (TBWC QuoteImportPanel, 2026-10-16: a run sat on one job forever because
   * nothing here could be cancelled), and fetch only stops on an abort signal.
   */
  upload(path: string, file: File, signal?: AbortSignal): Promise<void>;
  remove(path: string, signal?: AbortSignal): Promise<void>;
  /**
   * Signed URL for viewing the object. Short-lived by default (the adapter's own
   * TTL); pass `ttlSeconds` for links that outlive the click — an emailed link
   * isn't opened until the mail is read, so the default TTL is dead by then.
   */
  viewUrl(path: string, ttlSeconds?: number): Promise<string>;
  /** Do the bytes at `path` really exist (post-upload verification)? */
  stat?(path: string, signal?: AbortSignal): Promise<StoredObjectStat>;
}

/** Object key for a record's file. Backend re-derives the prefix and rejects mismatches. */
export function storagePathFor(entityType: string, entityId: string, fileName: string): string {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(-120);
  // Random prefix keeps same-named uploads from overwriting each other.
  const unique =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${entityType}/${entityId}/${unique}-${safeName}`;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`;
}

/**
 * The document types a role may see for one module, read off its own grant —
 * the browser-side mirror of allowedOptions() in the backend's permissions.ts,
 * which is what actually enforces it (this only decides what the grid offers
 * and shows). Driven by `doc_type:<value>` view bits on the module's Documents
 * read grant, which Settings > Roles > <Module> > Documents > Type edits.
 *
 * Returns undefined when nothing is turned off — DocumentsGrid's visibleDocTypes
 * takes that to mean "no filtering", so the common case costs nothing.
 *
 * Pass the isFieldVisible from the app's own auth context, e.g.
 *   allowedDocTypes(isFieldVisible, 'orderGridDocument:read')
 */
export function allowedDocTypes(
  isFieldVisible: (permission: string, field: string) => boolean,
  readPermission: string
): DocType[] | undefined {
  const allowed = DOC_TYPES.filter((t) => isFieldVisible(readPermission, `doc_type:${t}`));
  return allowed.length === DOC_TYPES.length ? undefined : [...allowed];
}
