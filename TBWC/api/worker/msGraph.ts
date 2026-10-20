/**
 * Microsoft Graph app-only (client credentials) client for real Excel Online
 * editing of xlsx/xls documents — see routes/documents.ts's office-edit
 * routes and officeEditSync.ts for the callers.
 *
 * App-only, not per-user: the app itself authenticates (no end user ever
 * signs into Microsoft), and who may open a file for edit is decided purely
 * by TBWC's own write permission on that document row. The actual Excel
 * Online session needs no Microsoft identity either — open() mints an
 * anonymous SharePoint "anyone with the link can edit" share link, which
 * requires the target site's sharing policy to allow "Anyone" links (admin
 * center > Policies > Sharing). A signed-in-only link would force every
 * editor to have their own Microsoft 365 account on this tenant, which this
 * feature deliberately does not require.
 *
 * One-time setup this all depends on (see CLAUDE.md feedback given at build
 * time, not reproduced here): an Azure AD app registration with the
 * Sites.Selected application permission (admin-consented), granted write
 * access to exactly one SharePoint site via a Graph Explorer call, and that
 * site's ID in MS_SITE_ID.
 */
import type { Env } from './db';

const GRAPH = 'https://graph.microsoft.com/v1.0';
// Edit-session copies live under this folder in the site's default document
// library, one file per document_id — stable across renames (entity_id/path
// can change; document_id never does), so re-opening always targets the same
// SharePoint item instead of leaking a new one per edit.
const EDIT_FOLDER = 'TBWC-OfficeEdit';
// Graph's own ceiling for a driveItem subscription (4230 minutes ~ 2.94 days).
// Renewed daily with a comfortable margin — see officeEditSync.ts's cron.
const SUBSCRIPTION_MINUTES = 4200;

export class MsGraphError extends Error {}

function requireConfig(env: Env): { tenantId: string; clientId: string; clientSecret: string; siteId: string } {
  const { MS_TENANT_ID: tenantId, MS_CLIENT_ID: clientId, MS_CLIENT_SECRET: clientSecret, MS_SITE_ID: siteId } = env;
  if (!tenantId || !clientId || !clientSecret || !siteId) {
    throw new MsGraphError('Microsoft Graph is not configured (MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET/MS_SITE_ID)');
  }
  return { tenantId, clientId, clientSecret, siteId };
}

// Cached per warm isolate only — a cold start just pays one extra token
// fetch, not worth persisting across isolates for a token that outlives most
// isolates anyway (~1hr TTL).
let cachedToken: { token: string; expiresAt: number } | null = null;

async function getAppToken(env: Env): Promise<string> {
  const { tenantId, clientId, clientSecret } = requireConfig(env);
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.token;

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) throw new MsGraphError(`Graph token request failed: ${res.status} ${await res.text().catch(() => '')}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return body.access_token;
}

async function graphFetch(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAppToken(env);
  const res = await fetch(`${GRAPH}${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new MsGraphError(`Graph ${init.method || 'GET'} ${path} failed: ${res.status} ${await res.text().catch(() => '')}`);
  }
  return res;
}

export interface GraphDriveItem {
  id: string;
  eTag: string;
  webUrl: string;
  parentReference: { driveId: string };
}

/** Overwrites (or creates) the edit-session copy at TBWC-OfficeEdit/{document_id}-{fileName}. Simple PUT
 *  content handles up to 250MB — comfortably past DocumentsGrid's own 25MB cap, so no upload session needed. */
export async function uploadEditCopy(
  env: Env, documentId: number, fileName: string, bytes: ArrayBuffer, contentType: string
): Promise<GraphDriveItem> {
  const { siteId } = requireConfig(env);
  const safeName = `${documentId}-${fileName}`.replace(/[^a-zA-Z0-9._ -]+/g, '_');
  const res = await graphFetch(
    env,
    `/sites/${siteId}/drive/root:/${EDIT_FOLDER}/${encodeURIComponent(safeName)}:/content`,
    { method: 'PUT', headers: { 'Content-Type': contentType }, body: bytes }
  );
  return res.json();
}

/** Anonymous "anyone with the link can edit" link — no Microsoft sign-in required to open it.
 *  Needs the target site's sharing policy to allow Anyone links. */
export async function createAnonymousEditLink(env: Env, driveId: string, itemId: string): Promise<string> {
  const res = await graphFetch(env, `/drives/${driveId}/items/${itemId}/createLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'edit', scope: 'anonymous' }),
  });
  const body = (await res.json()) as { link: { webUrl: string } };
  return body.link.webUrl;
}

export interface GraphSubscription {
  id: string;
  expirationDateTime: string;
}

/** Change notifications for this item, delivered to MS_WEBHOOK_BASE_URL — see
 *  routes/officeEditWebhook.ts. clientState is echoed back on every notification
 *  so the webhook can confirm it's really Graph (and which session it's for). */
export async function createChangeSubscription(
  env: Env, driveId: string, itemId: string, clientState: string
): Promise<GraphSubscription> {
  const { MS_WEBHOOK_BASE_URL } = env;
  if (!MS_WEBHOOK_BASE_URL) throw new MsGraphError('MS_WEBHOOK_BASE_URL is not configured');
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const res = await graphFetch(env, '/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      changeType: 'updated',
      notificationUrl: `${MS_WEBHOOK_BASE_URL}/api/office-edit-webhook`,
      resource: `/drives/${driveId}/items/${itemId}`,
      expirationDateTime,
      clientState,
    }),
  });
  return res.json();
}

export async function renewChangeSubscription(env: Env, subscriptionId: string): Promise<GraphSubscription> {
  const expirationDateTime = new Date(Date.now() + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  const res = await graphFetch(env, `/subscriptions/${subscriptionId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expirationDateTime }),
  });
  return res.json();
}

/** Current bytes + eTag for a driveItem — called after a change notification to pull the edit back. */
export async function downloadEditCopy(env: Env, driveId: string, itemId: string): Promise<{ bytes: ArrayBuffer; eTag: string; contentType: string }> {
  const meta = await graphFetch(env, `/drives/${driveId}/items/${itemId}`);
  const metaBody = (await meta.json()) as { eTag: string; file?: { mimeType?: string } };
  const content = await graphFetch(env, `/drives/${driveId}/items/${itemId}/content`);
  const bytes = await content.arrayBuffer();
  return { bytes, eTag: metaBody.eTag, contentType: metaBody.file?.mimeType || 'application/octet-stream' };
}
