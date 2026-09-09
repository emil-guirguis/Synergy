/**
 * Metadata client for the documents grid — talks to the app's own API (the
 * Worker route that wraps framework/backend/api/base/documents.ts), never to
 * the storage bucket. Bytes go through DocumentStorage instead (storage.ts).
 *
 * App-agnostic: the consuming app injects its API base URL and a token getter,
 * same pattern as framework/frontend/ai-chat.
 */
import type { CreateDocumentPayload, DocType, DocumentRecord, DocumentsApi } from './types';

export interface DocumentsApiConfig {
  /** e.g. "https://api.example.com/api" — the documents routes live at `${apiBaseUrl}/documents`. */
  apiBaseUrl: string;
  getToken: () => string | null;
  /** Override if an app mounts the routes somewhere other than /documents. */
  path?: string;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  message?: string;
}

export function createDocumentsApi(config: DocumentsApiConfig): DocumentsApi {
  const base = `${config.apiBaseUrl.replace(/\/$/, '')}${config.path ?? '/documents'}`;

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = config.getToken();
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  };

  async function request<T>(url: string, init?: RequestInit): Promise<T | undefined> {
    const res = await fetch(url, { ...init, headers: headers() });
    const body = (await res.json().catch(() => ({}))) as ApiEnvelope<T>;
    if (!res.ok || body.success === false) {
      throw new Error(body.message || `Request failed (${res.status})`);
    }
    return body.data;
  }

  return {
    async list(entityType: string, entityId: string): Promise<DocumentRecord[]> {
      const qs = new URLSearchParams({ entity_type: entityType, entity_id: String(entityId) });
      return (await request<DocumentRecord[]>(`${base}?${qs}`)) ?? [];
    },

    async create(payload: CreateDocumentPayload): Promise<DocumentRecord> {
      const row = await request<DocumentRecord>(base, { method: 'POST', body: JSON.stringify(payload) });
      return row as DocumentRecord;
    },

    async update(documentId: number, patch: { description?: string; docType?: DocType }): Promise<DocumentRecord> {
      const row = await request<DocumentRecord>(`${base}/${documentId}`, {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
      return row as DocumentRecord;
    },

    async remove(documentId: number): Promise<void> {
      await request<void>(`${base}/${documentId}`, { method: 'DELETE' });
    },
  };
}
