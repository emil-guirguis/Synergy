/**
 * Who may see which document row — shared by every path that reads
 * public.document without going through a module's own Documents grid route:
 * the AI chat tools (aiChat.ts) and the header search bar (aiSearch.ts).
 *
 * Two rules, both of which used to live only inside the feature that happened
 * to need them first:
 *
 *  1. entity_type allowlist — a free-text search across every record can't
 *     apply an own-scope row filter, so a module's documents are searchable
 *     only by a caller holding that module's Documents grid read at 'all'
 *     scope. 'support_ticket' is never searchable (owned per-ticket by filer/
 *     assignee, which no flat allowlist can express).
 *  2. the resource library's 'employee' type — docTypes.ts hides those files
 *     from the Resources browser for a caller without resource:write, and the
 *     same files must not come back from a document search either. Nearest
 *     typed ancestor wins, exactly as in the browser.
 */
import { Env, execQuery } from '../db';
import { DOCUMENT_GRID_KEYS } from '../permissions';
import type { PermissionSet } from '@meterit/framework-backend/api/base/permissions';

export type ResourceDocType = 'rep' | 'employee' | 'all';

/** Every doc_path -> type row. The table is small (one row per typed file/folder). */
export async function loadResourceTypeMap(env: Env): Promise<Map<string, ResourceDocType>> {
  const { rows } = await execQuery(
    env,
    'SELECT doc_path, doc_type FROM public.document_type',
    [],
    'docAccess.loadTypeMap'
  );
  return new Map(rows.map((r: any) => [r.doc_path, r.doc_type]));
}

/**
 * A type set on a folder is inherited by everything under it; the nearest
 * typed ancestor wins, and nothing typed anywhere up the chain means 'all'.
 * Mirrors ResourcesTab.tsx's typeOf().
 */
export function effectiveResourceType(types: Map<string, ResourceDocType>, path: string): ResourceDocType {
  for (let p = path; p; p = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') {
    const t = types.get(p);
    if (t) return t;
  }
  return 'all';
}

/**
 * entity_type values a document search may return for this caller: each module
 * whose Documents grid read they hold at 'all' scope, plus the resource library
 * with resource:read. Empty means "search nothing" — the framework's search
 * helpers treat an empty entityTypes array as matching nothing, so this fails
 * closed.
 */
export function allowedDocEntityTypes(permissions: PermissionSet): string[] {
  const types: string[] = [];
  for (const entityType of ['order', 'quote', 'invoice', 'inventory'] as const) {
    if (permissions.scopeOf(`${DOCUMENT_GRID_KEYS[entityType]}:read`) === 'all') types.push(entityType);
  }
  if (permissions.has('resource:read')) types.push('resource');
  return types;
}

/**
 * document_ids of 'employee'-typed resource files this caller may not see —
 * empty for anyone with resource:write, and skipped entirely when 'resource'
 * isn't in their allowlist (nothing to filter) or nothing is typed at all.
 * A resource document's entity_id IS its bucket path (see docTypes.ts's
 * upsertResourceDocument), which is what the type map is keyed on.
 */
export async function hiddenResourceDocIds(
  env: Env,
  permissions: PermissionSet,
  entityTypes: string[]
): Promise<Set<number>> {
  if (!entityTypes.includes('resource') || permissions.has('resource:write')) return new Set();
  const types = await loadResourceTypeMap(env);
  if (types.size === 0) return new Set();
  const { rows } = await execQuery(
    env,
    `SELECT document_id, entity_id FROM public.document WHERE entity_type = 'resource'`,
    [],
    'docAccess.resourceDocs'
  );
  return new Set(
    rows
      .filter((r: any) => effectiveResourceType(types, r.entity_id) === 'employee')
      .map((r: any) => r.document_id as number)
  );
}

/** Drops rows the caller may not see. Works on any shape carrying documentId —
 *  search matches, content hits, and the model's candidate list alike. */
export function withoutHiddenDocs<T extends { documentId: number }>(rows: T[], hidden: Set<number>): T[] {
  return hidden.size === 0 ? rows : rows.filter((r) => !hidden.has(r.documentId));
}
