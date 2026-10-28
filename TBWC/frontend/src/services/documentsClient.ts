/**
 * TBWC wiring for the framework documents module: metadata through the TBWC
 * Worker (/api/documents); bytes via signed URLs the Worker mints for the
 * private Supabase `record-docs` bucket after checking the caller's role. Both halves are app-agnostic in the framework — this file supplies the
 * URLs and the token getter, same pattern as features/ai/AiChatPage.tsx.
 */
import {
  createDocumentsApi,
  createWorkerDocumentStorage,
} from '@meterit/framework-frontend/documents';
import type { DocumentsApi, DocumentStorage } from '@meterit/framework-frontend/documents';
import { API_BASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import { withAuthRetry } from '../utils/authRetry';

/** Private bucket created in migrations/026-documents.sql. */
export const RECORD_DOCS_BUCKET = 'record-docs';

const rawApi = createDocumentsApi({
  apiBaseUrl: API_BASE_URL,
  getToken: () => tokenStorage.getToken(),
});

const rawStorage = createWorkerDocumentStorage({
  apiBaseUrl: API_BASE_URL,
  getToken: () => tokenStorage.getToken(),
  bucket: RECORD_DOCS_BUCKET,
  // DocumentsGrid's Email share puts this URL in a mailto: body — the default
  // 60s is meant for an immediate "Open" and would already be dead by the
  // time anyone opened the email.
  signedUrlTtl: 60 * 60 * 24 * 7,
});

// Both halves call the Worker directly,
// bypassing the zustand store middleware that normally catches an expired
// access token and refreshes it (createEntitySlice.ts's withAuthRetry) — an
// upload sitting on an open form for a while is exactly when this bites.
// getToken() above always re-reads tokenStorage live, so the retried call
// picks up the token authService.refresh() just wrote.
/**
 * Excel Online hand-off (worker/routes/documents.ts's office-edit route). Lives
 * here rather than in the framework's createDocumentsApi because it is the one
 * documents call that needs a backend with Microsoft Graph configured —
 * MeterItPro has none, and an app that doesn't implement this simply leaves
 * DocumentsGrid on its built-in editor.
 *
 * A 503 (Graph not configured — e.g. local dev without MS_SITE_ID) throws like
 * any other failure; the grid falls back to the built-in editor on any error.
 */
async function officeEdit(documentId: number): Promise<string> {
  const res = await fetch(`${API_BASE_URL.replace(/\/$/, '')}/documents/${documentId}/office-edit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenStorage.getToken() ?? ''}` },
  });
  const body = await res.json().catch(() => null);
  const editUrl = body?.data?.editUrl;
  if (!res.ok || typeof editUrl !== 'string') {
    throw new Error(body?.message || 'Could not open this file in Excel Online');
  }
  return editUrl;
}

export const documentsApi: DocumentsApi = {
  list: (entityType, entityId) => withAuthRetry(() => rawApi.list(entityType, entityId)),
  create: (payload) => withAuthRetry(() => rawApi.create(payload)),
  update: (documentId, patch) => withAuthRetry(() => rawApi.update(documentId, patch)),
  remove: (documentId) => withAuthRetry(() => rawApi.remove(documentId)),
  email: (documentId, input) => withAuthRetry(() => rawApi.email(documentId, input)),
  officeEdit: (documentId) => withAuthRetry(() => officeEdit(documentId)),
};

export const documentsStorage: DocumentStorage = {
  bucket: rawStorage.bucket,
  upload: (path, file, signal) => withAuthRetry(() => rawStorage.upload(path, file, signal)),
  remove: (path, signal) => withAuthRetry(() => rawStorage.remove(path, signal)),
  viewUrl: (path, ttlSeconds) => withAuthRetry(() => rawStorage.viewUrl(path, ttlSeconds)),
  stat: (path, signal) => withAuthRetry(() => rawStorage.stat!(path, signal)),
};
