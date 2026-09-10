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
  'other',
] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DEFAULT_DOC_TYPE: DocType = 'other';

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  cutsheet: 'Cutsheet',
  invoice: 'Invoice',
  order: 'Order',
  packing_slip: 'Packing Slip',
  proof_of_delivery: 'Proof of Delivery',
  shipping: 'Shipping',
  email: 'Email',
  design: 'Design',
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

/** Metadata CRUD against the app's own API (the Worker), never the bucket. */
export interface DocumentsApi {
  list(entityType: string, entityId: string): Promise<DocumentRecord[]>;
  create(payload: CreateDocumentPayload): Promise<DocumentRecord>;
  update(documentId: number, patch: { description?: string; docType?: DocType }): Promise<DocumentRecord>;
  remove(documentId: number): Promise<void>;
}

/**
 * The bytes half. Implemented today by createSupabaseDocumentStorage (browser →
 * Supabase Storage direct); a DB-blob or R2 implementation can be dropped in
 * without the grid noticing.
 */
export interface DocumentStorage {
  bucket: string;
  upload(path: string, file: File): Promise<void>;
  remove(path: string): Promise<void>;
  /** Short-lived URL for viewing the object in a new tab. */
  viewUrl(path: string): Promise<string>;
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
