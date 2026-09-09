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
import { API_BASE_URL, SUPABASE_ANON_KEY, SUPABASE_URL } from '../config/api';
import { tokenStorage } from '../utils/tokenStorage';

/** Private bucket created in migrations/026-documents.sql. */
export const RECORD_DOCS_BUCKET = 'record-docs';

export const documentsApi = createDocumentsApi({
  apiBaseUrl: API_BASE_URL,
  getToken: () => tokenStorage.getToken(),
});

export const documentsStorage = createSupabaseDocumentStorage({
  supabaseUrl: SUPABASE_URL,
  anonKey: SUPABASE_ANON_KEY,
  getToken: () => tokenStorage.getToken(),
  bucket: RECORD_DOCS_BUCKET,
});
