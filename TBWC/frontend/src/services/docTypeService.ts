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

export async function setDocType(path: string, type: DocType): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/doc-types`, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({ path, type }),
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

export async function deleteDocType(path: string): Promise<void> {
  await parse(
    await fetch(`${API_BASE_URL}/doc-types`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ path }),
    })
  );
}
