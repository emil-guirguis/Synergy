/**
 * Child-row grids — CRUD for rows that live under a parent record and are
 * edited one row at a time in a grid inside the parent's form (quote_line
 * under quote, ...). Driven entirely by a defineSchema() result that declares
 * `parent` (see SchemaDefinition.js): table, PK, FK to the parent, order
 * column and which columns are writable all come from the schema, so a new
 * child grid is a schema file plus a thin route wrapper, not another
 * hand-rolled replace-all-lines loop.
 *
 * Same shape as roles.ts/documents.ts: plain functions, no Hono import —
 * each app wraps them in its own routes with its own auth + parent-visibility
 * checks (the parent's own-scope rules are app-specific, e.g. TBWC's
 * sales_rep_list_id).
 *
 * Permissions: a child schema registered under key K gets K:<action> for each
 * of parent.actions (default read/create/write/delete) — see
 * childSchemaPermissions(). Apps append these to their static catalog so the
 * roles tree and route guards pick up a new grid with no hand-written strings.
 */
import type { ExecQueryFn } from './crud';
import { redactRows, type PermissionSet } from './permissions';

export type TxQuery = (text: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
export type WithTransactionFn = <T>(env: any, fn: (q: TxQuery) => Promise<T>) => Promise<T>;

/** A defineSchema() result (only the parts used here). */
interface SchemaLike {
  schema: {
    tableName: string;
    idFieldName: string | null;
    formFields: Record<string, { dbField?: string | null; readOnly?: boolean }>;
    entityFields?: Record<string, { dbField?: string | null }>;
    parent: {
      entity: string;
      foreignKey: string;
      label?: string | null;
      orderField?: string | null;
      actions: string[];
    } | null;
  };
}

export interface ChildRowsConfig {
  schema: SchemaLike;
  /**
   * Fill derived columns before a write (e.g. amount = quantity * rate, or an
   * authoritative item name looked up from the picked id). Receives the full
   * row as it will be stored (existing values merged with the patch) and
   * returns it; may set read-only schema columns, never the PK/FK/order.
   * Throw ChildRowValidationError to reject the write with a 400.
   */
  prepare?: (row: Record<string, any>, q: TxQuery, parentId: string | number) => Promise<Record<string, any>> | Record<string, any>;
  /**
   * Rows as the grid reads them, when they need more than the table's own
   * columns (e.g. the managed user's name). The child table is aliased `t`:
   * `{ columns: 't.*, u.first_name', joins: 'JOIN public.users u ON u.id = t.managed_user_id' }`.
   * Used for list and to re-read a row after create/update.
   */
  select?: { columns: string; joins: string; orderBy?: string };
  /**
   * Runs inside the same transaction after every create/update/delete — e.g.
   * recompute the parent's total. Whatever it returns comes back to the
   * caller as `parent`, so the grid can refresh a parent-level figure.
   */
  afterChange?: (q: TxQuery, parentId: string | number) => Promise<Record<string, any> | void>;
}

export class ChildRowNotFoundError extends Error {}
export class ChildRowValidationError extends Error {}
/** A unique constraint rejected the write (e.g. managing the same user twice) — map to 409. */
export class ChildRowConflictError extends Error {}

/** Postgres unique_violation -> ChildRowConflictError; anything else rethrown as-is. */
function mapDbError(err: any): never {
  if (err?.code === '23505') throw new ChildRowConflictError('That row already exists');
  throw err;
}

/** Re-read one row through cfg.select (joins included) inside the transaction. */
async function reselect(q: TxQuery, cfg: ChildRowsConfig, table: string, pk: string, id: any, fallback: any) {
  if (!cfg.select) return fallback;
  const r = await q(`SELECT ${cfg.select.columns} FROM public.${table} t ${cfg.select.joins} WHERE t.${pk} = $1`, [id]);
  return r.rows[0] ?? fallback;
}

const DEFAULT_ACTIONS = ['read', 'create', 'write', 'delete'];

/**
 * For a grid whose rows live on the parent row as a jsonb array (schema
 * parent.field, e.g. a QB-synced order's `lines`): without `<key>:read` the
 * array is dropped from the response entirely; with it, each element is
 * redacted by that grant's hidden fields (plain column names — `rate`, not
 * `lines[].rate`). Returns a copy; rows without the field pass through.
 */
export function applyEmbeddedGrid<T extends Record<string, any>>(set: PermissionSet, key: string, field: string, row: T): T {
  if (!row || !(field in row)) return row;
  const out: Record<string, any> = { ...row };
  const permission = `${key}:read`;
  if (!set.has(permission)) delete out[field];
  else if (Array.isArray(out[field])) out[field] = redactRows(set, permission, out[field]);
  return out as T;
}

/** `key:action` for every registered child schema — append to the app's permission catalog. */
export function childSchemaPermissions(children: Record<string, SchemaLike>): string[] {
  return Object.entries(children).flatMap(([key, s]) =>
    (s.schema.parent?.actions ?? DEFAULT_ACTIONS).map((action) => `${key}:${action}`)
  );
}

function meta(cfg: ChildRowsConfig) {
  const s = cfg.schema.schema;
  if (!s.parent) throw new Error(`Schema ${s.tableName} has no parent — not a child-row schema`);
  if (!s.idFieldName) throw new Error(`Schema ${s.tableName} has no idFieldName`);
  const table = s.tableName;
  const pk = s.idFieldName;
  const fk = s.parent.foreignKey;
  const orderField = s.parent.orderField ?? null;
  const reserved = new Set([pk, fk, ...(orderField ? [orderField] : [])]);
  const columnOf = (def: { dbField?: string | null }) => def.dbField ?? null;

  /** Columns a caller may send. */
  const writable = new Set(
    Object.values(s.formFields)
      .filter((d) => !d.readOnly)
      .map(columnOf)
      .filter((c): c is string => !!c && !reserved.has(c))
  );
  /** Columns prepare() may set (writable plus schema-declared read-only/computed ones). */
  const storable = new Set(
    [...Object.values(s.formFields), ...Object.values(s.entityFields ?? {})]
      .map(columnOf)
      .filter((c): c is string => !!c && !reserved.has(c))
  );
  return { table, pk, fk, orderField, writable, storable };
}

function pickWritable(writable: Set<string>, body: any): Record<string, any> {
  const out: Record<string, any> = {};
  if (!body || typeof body !== 'object') return out;
  for (const [k, v] of Object.entries(body)) if (writable.has(k)) out[k] = v;
  return out;
}

export async function listChildren(
  execQuery: ExecQueryFn, env: any, cfg: ChildRowsConfig, parentId: string | number
): Promise<any[]> {
  const { table, pk, fk, orderField } = meta(cfg);
  const order = cfg.select?.orderBy ?? (orderField ? `t.${orderField} ASC, t.${pk} ASC` : `t.${pk} ASC`);
  const r = await execQuery(
    env,
    `SELECT ${cfg.select?.columns ?? 't.*'} FROM public.${table} t ${cfg.select?.joins ?? ''}
      WHERE t.${fk} = $1 ORDER BY ${order}`,
    [parentId],
    `childRows.list.${table}`
  );
  return r.rows;
}

export async function createChild(
  withTransaction: WithTransactionFn, env: any, cfg: ChildRowsConfig, parentId: string | number, body: any
): Promise<{ row: any; parent: Record<string, any> | void }> {
  const { table, pk, fk, orderField, writable, storable } = meta(cfg);
  return withTransaction(env, async (q) => {
    let row = pickWritable(writable, body);
    if (cfg.prepare) row = await cfg.prepare(row, q, parentId);
    const cols = Object.keys(row).filter((c) => storable.has(c));
    const values = cols.map((c) => row[c]);
    cols.unshift(fk);
    values.unshift(parentId);
    if (orderField) {
      const next = await q(
        `SELECT COALESCE(MAX(${orderField}), -1) + 1 AS n FROM public.${table} WHERE ${fk} = $1`,
        [parentId]
      );
      cols.push(orderField);
      values.push(next.rows[0].n);
    }
    const r = await q(
      `INSERT INTO public.${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      values
    ).catch(mapDbError);
    const parent = cfg.afterChange ? await cfg.afterChange(q, parentId) : undefined;
    return { row: await reselect(q, cfg, table, pk, r.rows[0]?.[pk], r.rows[0]), parent };
  });
}

export async function updateChild(
  withTransaction: WithTransactionFn, env: any, cfg: ChildRowsConfig,
  parentId: string | number, childId: string | number, body: any
): Promise<{ row: any; parent: Record<string, any> | void }> {
  const { table, pk, fk, writable, storable } = meta(cfg);
  const patch = pickWritable(writable, body);
  if (Object.keys(patch).length === 0) throw new ChildRowValidationError('No editable fields in request');
  return withTransaction(env, async (q) => {
    const existing = await q(
      `SELECT * FROM public.${table} WHERE ${pk} = $1 AND ${fk} = $2 FOR UPDATE`,
      [childId, parentId]
    );
    if (!existing.rows[0]) throw new ChildRowNotFoundError('Row not found');
    let row = { ...existing.rows[0], ...patch };
    if (cfg.prepare) row = await cfg.prepare(row, q, parentId);
    const cols = Object.keys(row).filter((c) => storable.has(c));
    const values = cols.map((c) => row[c]);
    values.push(childId, parentId);
    const r = await q(
      `UPDATE public.${table} SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')}
        WHERE ${pk} = $${cols.length + 1} AND ${fk} = $${cols.length + 2} RETURNING *`,
      values
    ).catch(mapDbError);
    const parent = cfg.afterChange ? await cfg.afterChange(q, parentId) : undefined;
    return { row: await reselect(q, cfg, table, pk, childId, r.rows[0]), parent };
  });
}

export async function deleteChild(
  withTransaction: WithTransactionFn, env: any, cfg: ChildRowsConfig,
  parentId: string | number, childId: string | number
): Promise<{ row: any; parent: Record<string, any> | void }> {
  const { table, pk, fk } = meta(cfg);
  return withTransaction(env, async (q) => {
    const r = await q(
      `DELETE FROM public.${table} WHERE ${pk} = $1 AND ${fk} = $2 RETURNING *`,
      [childId, parentId]
    );
    if (!r.rows[0]) throw new ChildRowNotFoundError('Row not found');
    const parent = cfg.afterChange ? await cfg.afterChange(q, parentId) : undefined;
    return { row: r.rows[0], parent };
  });
}
