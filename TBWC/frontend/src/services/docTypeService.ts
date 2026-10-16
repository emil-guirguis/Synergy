/**
 * Client for the Worker's /api/doc-types — the "who sees it" type (rep /
 * employee / all) for each file in the `rep-docs` Storage bucket. Kept in our
 * own DB rather than on the Storage object itself; see
 * TBWC/api/migrations/015-rep-doc-type.sql.
 */
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

export type DocType = 'rep' | 'employee' | 'all';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function parse(res: Response) {
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `HTTP ${res.status}: ${res.statusText}`);
  }
  return res.json();
}

/** Path -> type, for every file that has one set. Missing paths default to 'all'. */
export async function getDocTypes(): Promise<Record<string, DocType>> {
  const data = await parse(await fetch(`${API_BASE_URL}/doc-types`, { headers: authHeaders() }));
  return data.data || {};
}

/** fileSize/mimeType are only known at upload time — pass them then so the mirrored
 * public.document row (entity_type='resource', see migrations/089) gets real metadata;
 * omit on a plain type change (dropdown only) and the existing values are kept. */
export async function setDocType(
  path: string,
  type: DocType,
  file?: { size: number; mimeType: string }
): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/doc-types`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ path, type, fileSize: file?.size, mimeType: file?.mimeType }),
    })
  );
}

export async function renameDocType(fromPath: string, toPath: string): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/doc-types`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ fromPath, toPath }),
    })
  );
}

/**
 * Emails one resource file as an attachment. The Worker reads the bytes out of
 * the bucket and sends them, so the file never lands in the sender's downloads —
 * a browser cannot attach a file to the machine's mail client at all (see
 * api/worker/fileEmail.ts). Resolves with the addresses it went to.
 */
export async function emailResource(
  path: string,
  input: { to: string; subject?: string; message?: string }
): Promise<string[]> {
  const data = await parse(
    await fetch(`${API_BASE_URL}/doc-types/email`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ path, ...input }),
    })
  );
  return data.data?.recipients ?? [];
}

export async function deleteDocType(path: string): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/doc-types`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ path }),
    })
  );
}
