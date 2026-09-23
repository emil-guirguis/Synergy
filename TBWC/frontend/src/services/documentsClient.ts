/**
 * TBWC wiring for the framework documents module: metadata through the TBWC
 * Worker (/api/documents), bytes through the private Supabase `record-docs`
 * bucket. Both halves are app-agnostic in the framework — this file supplies the
 * URLs and the token getter, same pattern as features/ai/AiChatPage.tsx.
 */
import {
  createDocumentsApi,
  createSupabaseDocumentStorage,
} from '@meterit/framework-frontend/documents';
import type { DocumentsApi, DocumentStorage } from '@meterit/framework-frontend/documents';
import { API_BASE_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';
import { withAuthRetry } from '../utils/authRetry';

/** Private bucket created in migrations/026-documents.sql. */
export const RECORD_DOCS_BUCKET = 'record-docs';

const rawApi = createDocumentsApi({
  apiBaseUrl: API_BASE_URL,
  getToken: () => tokenStorage.getToken(),
});

const rawStorage = createSupabaseDocumentStorage({
  supabaseUrl: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  getToken: () => tokenStorage.getToken(),
  bucket: RECORD_DOCS_BUCKET,
});

// Both halves talk straight to their own backend (Worker / Supabase Storage),
// bypassing the zustand store middleware that normally catches an expired
// access token and refreshes it (createEntitySlice.ts's withAuthRetry) — an
// upload sitting on an open form for a while is exactly when this bites.
// getToken() above always re-reads tokenStorage live, so the retried call
// picks up the token authService.refresh() just wrote.
export const documentsApi: DocumentsApi = {
  list: (entityType, entityId) => withAuthRetry(() => rawApi.list(entityType, entityId)),
  create: (payload) => withAuthRetry(() => rawApi.create(payload)),
  update: (documentId, patch) => withAuthRetry(() => rawApi.update(documentId, patch)),
  remove: (documentId) => withAuthRetry(() => rawApi.remove(documentId)),
};

export const documentsStorage: DocumentStorage = {
  bucket: rawStorage.bucket,
  upload: (path, file) => withAuthRetry(() => rawStorage.upload(path, file)),
  remove: (path) => withAuthRetry(() => rawStorage.remove(path)),
  viewUrl: (path) => withAuthRetry(() => rawStorage.viewUrl(path)),
};
