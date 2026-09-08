/**
 * Generic CRUD SQL helpers for Hono worker routes — the framework-shared
 * implementation. Every consuming app's local `worker/crud.ts` is a thin shim:
 *
 *   import { createCrud } from '@meterit/framework-backend/api/base/crud';
 *   import { execQuery } from './db';
 *   export const { findAll, findById, create, update, remove,
 *     checkDeleteRestrictions } = createCrud(execQuery);
 *   export { whereFromQuery, likeFieldsFromSchema } from '@meterit/framework-backend/api/base/crud';
 *
 * Identifier inputs (table, column names, where keys, searchFields, sortBy)
 * are validated against SAFE_IDENT to prevent SQL injection. Free-form SQL
 * fragments (joins, selectFields, explicit orderBy) remain caller-trusted —
 * never derive these from request input.
 */

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertIdent(name: string, kind: string): void {
  if (typeof name !== 'string' || !SAFE_IDENT.test(name)) {
    throw new Error(`Invalid ${kind}: ${name}`);
  }
}

// Columns never writable via update()
const UPDATE_DENYLIST = new Set(['tenant_id', 'created_at', 'updated_at']);

// Query keys findAll's own options already consume — never treated as a field filter.
const RESERVED_QUERY_KEYS = new Set(['page', 'limit', 'search', 'sortBy', 'sortOrder']);

/** Convert camelCase to snake_case for DB column names */
function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export type ExecQueryFn = (
  env: any,
  sql: string,
  params?: any[],
  logMessage?: string
) => Promise<{ rows: any[]; rowCount: number | null }>;

export interface FindAllOptions {
  table: string;
  primaryKey: string;
  tenantId?: number;
  page?: number;
  limit?: number;
  search?: string;
  searchFields?: string[];
  where?: Record<string, any>;
  /** Per-field partial (ILIKE) matches, AND'ed together — unlike `search`, which OR's one term across multiple fields. */
  whereLike?: Record<string, string>;
  orderBy?: string;
  sortBy?: string;
  sortOrder?: string;
  joins?: string;
  selectFields?: string;
}

export interface FindAllResult {
  rows: any[];
  pagination: {
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  };
}

/**
 * Build findAll() `where`/`whereLike` objects from a route's raw query string.
 * The frontend's schema-driven per-field filters (select/boolean/text) each post
 * their field name as its own top-level query param. Select/boolean filters are
 * exact-match (coercing the 'true'/'false' strings boolean filters send); free-text
 * filters — passed via `likeFields`, typically likeFieldsFromSchema()'s result —
 * need a partial ILIKE match instead, or e.g. filtering phone "71" would require
 * the stored value to be exactly "71" rather than contain it.
 * Pass `extraReserved` for route-specific params that aren't field filters
 * (e.g. a route already building its own security-scoped `where` key).
 * Pass `fieldMap` (from fieldMapFromSchema()) when a schema's field name can
 * differ from its DB column — the query param is still the field name (that's
 * what the frontend filter posts), but the emitted where/whereLike key must be
 * the actual column, or the generated SQL references a column that doesn't exist.
 */
export function whereFromQuery(
  query: Record<string, string>,
  opts: { likeFields?: string[]; extraReserved?: string[]; fieldMap?: Record<string, string> } = {}
): { where: Record<string, any>; whereLike: Record<string, string> } {
  const likeFields = new Set(opts.likeFields || []);
  const extraReserved = new Set(opts.extraReserved || []);
  const fieldMap = opts.fieldMap || {};
  const where: Record<string, any> = {};
  const whereLike: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (RESERVED_QUERY_KEYS.has(key) || extraReserved.has(key)) continue;
    if (value === '') continue;
    const column = fieldMap[key] || key;
    if (likeFields.has(key)) {
      whereLike[column] = value;
    } else if (value === 'true') {
      where[column] = true;
    } else if (value === 'false') {
      where[column] = false;
    } else {
      where[column] = value;
    }
  }
  return { where, whereLike };
}

/**
 * Map every schema field name to its DB column (dbField), for fields that have
 * one. Pass the result as whereFromQuery()'s `fieldMap` so a schema field whose
 * name differs from its column (e.g. JS-side 'isActive' stored as db 'isactive')
 * still resolves to real SQL, instead of whereFromQuery emitting a where/whereLike
 * key that matches nothing in the table.
 */
export function fieldMapFromSchema(
  schema: { formFields?: Record<string, any> } | { schema: { formFields: Record<string, any> } }
): Record<string, string> {
  const formFields: Record<string, any> =
    (schema as any).formFields ?? (schema as any).schema?.formFields ?? {};
  const map: Record<string, string> = {};
  for (const [name, def] of Object.entries(formFields) as [string, any][]) {
    if (def?.dbField) map[name] = def.dbField;
  }
  return map;
}

/**
 * Derive the free-text (ILIKE) filter fields for a defineSchema() entity:
 * every list-shown field that's a plain string/number column with no fixed
 * set of values. Mirrors the frontend's generateFiltersFromSchema() — a field
 * only gets a text-input filter there when it isn't boolean and has no
 * enumValues — so this is the single source of truth for both, and a route
 * never needs to hand-maintain its own list of "which fields are free text."
 * Returns field names (matching the query param a filter posts) — pair with
 * fieldMapFromSchema() when a field's name and DB column differ.
 */
export function likeFieldsFromSchema(
  schema: { formFields?: Record<string, any> } | { schema: { formFields: Record<string, any> } }
): string[] {
  const formFields: Record<string, any> =
    (schema as any).formFields ?? (schema as any).schema?.formFields ?? {};
  return Object.entries(formFields)
    .filter(([, def]: [string, any]) => {
      const showOn = Array.isArray(def.showOn) ? def.showOn : [];
      if (!showOn.includes('list')) return false;
      if (def.enumValues && def.enumValues.length > 0) return false;
      return def.type === 'string' || def.type === 'number';
    })
    .map(([name]) => name);
}

export interface DeleteRestriction {
  table: string; // child table holding the FK
  fk: string; // FK column in the child table
  label?: string; // human name for the children (defaults to table)
  message?: string; // full override for the error message
}

export interface DeleteRestrictionViolation {
  table: string;
  count: number;
  message: string;
}

/**
 * Bind every helper to one app's execQuery(env, sql, params, logMessage?).
 * Each consuming app's local worker/crud.ts calls this once and re-exports
 * the result — see the module doc comment above for the exact shim shape.
 */
export function createCrud(execQuery: ExecQueryFn) {
  async function findAll(env: any, opts: FindAllOptions): Promise<FindAllResult> {
    const {
      table,
      primaryKey,
      tenantId,
      page = 1,
      limit = 25,
      search,
      searchFields = ['name'],
      where = {},
      whereLike = {},
      sortBy,
      sortOrder,
      joins = '',
      selectFields = `"${opts.table}".*`,
    } = opts;

    assertIdent(table, 'table');
    assertIdent(primaryKey, 'primaryKey');
    for (const f of searchFields) assertIdent(f, 'searchField');
    for (const k of Object.keys(where)) assertIdent(k, 'whereKey');
    for (const k of Object.keys(whereLike)) assertIdent(k, 'whereLikeKey');

    // Build orderBy: explicit orderBy > sortBy param > primary key fallback
    let orderBy = opts.orderBy;
    if (!orderBy) {
      if (sortBy) {
        const col = camelToSnake(sortBy);
        assertIdent(col, 'sortBy');
        const dir = (sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
        // Postgres defaults NULLS FIRST on DESC (NULLS LAST on ASC already matches
        // what users expect) — force NULLS LAST both ways so blank values never
        // jump to the top of a descending sort.
        orderBy = `"${table}".${col} ${dir} NULLS LAST`;
      } else {
        orderBy = `"${table}".${primaryKey} DESC`;
      }
    }

    const params: any[] = [];
    let paramIdx = 1;
    const whereClauses: string[] = [];

    // Add tenant filter if tenantId is provided
    if (tenantId !== undefined) {
      whereClauses.push(`"${table}".tenant_id = $${paramIdx}`);
      params.push(tenantId);
      paramIdx++;
    }

    // Search filter — one term OR'd across multiple fields
    if (search && searchFields.length > 0) {
      const searchClauses = searchFields.map((f) => `LOWER("${table}".${f}) LIKE LOWER($${paramIdx})`);
      whereClauses.push(`(${searchClauses.join(' OR ')})`);
      params.push(`%${search}%`);
      paramIdx++;
    }

    // Additional exact-match where conditions
    for (const [key, value] of Object.entries(where)) {
      if (value === null) {
        whereClauses.push(`"${table}".${key} IS NULL`);
      } else {
        whereClauses.push(`"${table}".${key} = $${paramIdx}`);
        params.push(value);
        paramIdx++;
      }
    }

    // Per-field partial matches (AND'ed, unlike the OR'd `search` above).
    // Cast to text so this also works against numeric columns.
    for (const [key, value] of Object.entries(whereLike)) {
      if (value === '' || value == null) continue;
      whereClauses.push(`LOWER("${table}".${key}::text) LIKE LOWER($${paramIdx})`);
      params.push(`%${value}%`);
      paramIdx++;
    }

    const whereSQL = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count query
    const countSql = `SELECT COUNT(*) as total FROM "${table}" ${joins} ${whereSQL}`;
    const countResult = await execQuery(env, countSql, params);
    const total = parseInt(countResult.rows[0].total, 10);

    // Data query
    const offset = (page - 1) * limit;
    const dataParams = [...params, limit, offset];
    const dataSql = `SELECT ${selectFields} FROM "${table}" ${joins} ${whereSQL} ORDER BY ${orderBy} LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    const dataResult = await execQuery(env, dataSql, dataParams);

    return {
      rows: dataResult.rows,
      pagination: {
        total,
        page,
        pageSize: limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async function findById(
    env: any,
    table: string,
    primaryKey: string,
    id: any,
    tenantId?: number,
    selectFields?: string
  ) {
    assertIdent(table, 'table');
    assertIdent(primaryKey, 'primaryKey');
    const cols = selectFields || `"${table}".*`;
    let sql = `SELECT ${cols} FROM "${table}" WHERE ${primaryKey} = $1`;
    const params: any[] = [id];

    if (tenantId !== undefined) {
      sql += ' AND tenant_id = $2';
      params.push(tenantId);
    }

    const result = await execQuery(env, sql, params);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async function create(env: any, table: string, data: Record<string, any>) {
    assertIdent(table, 'table');
    const keys = Object.keys(data).filter((k) => data[k] !== undefined);
    for (const k of keys) assertIdent(k, 'column');
    const values = keys.map((k) => data[k]);
    const placeholders = keys.map((_, i) => `$${i + 1}`);

    const sql = `INSERT INTO "${table}" (${keys.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`;
    const result = await execQuery(env, sql, values);
    return result.rows[0];
  }

  /**
   * `touchUpdatedAt` (default true) appends `updated_at = NOW()`. Set it false
   * for tables with no such column — pass `{ touchUpdatedAt: false }`.
   */
  async function update(
    env: any,
    table: string,
    primaryKey: string,
    id: any,
    data: Record<string, any>,
    opts: { touchUpdatedAt?: boolean } = {}
  ) {
    const { touchUpdatedAt = true } = opts;
    assertIdent(table, 'table');
    assertIdent(primaryKey, 'primaryKey');
    const keys = Object.keys(data).filter(
      (k) => data[k] !== undefined && k !== primaryKey && !UPDATE_DENYLIST.has(k)
    );
    if (keys.length === 0) return null;
    for (const k of keys) assertIdent(k, 'column');

    const setClauses = keys.map((k, i) => `${k} = $${i + 1}`);
    const values = keys.map((k) => data[k]);
    if (touchUpdatedAt) setClauses.push('updated_at = NOW()');
    values.push(id);

    const sql = `UPDATE "${table}" SET ${setClauses.join(', ')} WHERE ${primaryKey} = $${values.length} RETURNING *`;
    const result = await execQuery(env, sql, values);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Check a schema's deleteRestrictions before deleting a row.
   * Returns null when deletable, or a violation with a user-facing message.
   * The matching DB FK should be ON DELETE RESTRICT as the backstop.
   */
  async function checkDeleteRestrictions(
    env: any,
    schema: { deleteRestrictions?: DeleteRestriction[] },
    id: any
  ): Promise<DeleteRestrictionViolation | null> {
    const rules = schema.deleteRestrictions || [];
    for (const rule of rules) {
      assertIdent(rule.table, 'table');
      assertIdent(rule.fk, 'fk column');
      const result = await execQuery(env, `SELECT COUNT(*)::int AS count FROM ${rule.table} WHERE ${rule.fk} = $1`, [id]);
      const count = result.rows[0]?.count ?? 0;
      if (count > 0) {
        const label = rule.label || rule.table.replace(/_/g, ' ');
        return {
          table: rule.table,
          count,
          message:
            rule.message ||
            `Cannot delete — ${count} ${label}${count === 1 ? '' : 's'} still reference this record. Reassign or remove them first.`,
        };
      }
    }
    return null;
  }

  async function remove(env: any, table: string, primaryKey: string, id: any, tenantId?: number) {
    assertIdent(table, 'table');
    assertIdent(primaryKey, 'primaryKey');
    let sql = `DELETE FROM "${table}" WHERE ${primaryKey} = $1`;
    const params: any[] = [id];
    if (tenantId !== undefined) {
      sql += ' AND tenant_id = $2';
      params.push(tenantId);
    }
    sql += ' RETURNING *';
    const result = await execQuery(env, sql, params);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  return { findAll, findById, create, update, remove, checkDeleteRestrictions };
}
