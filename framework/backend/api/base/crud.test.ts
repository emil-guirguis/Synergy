import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createCrud, whereFromQuery, likeFieldsFromSchema, fieldMapFromSchema } from './crud';

// Capture every execQuery call so we can assert on the generated SQL + params.
const calls: { sql: string; params: any[] }[] = [];
let responses: any[] = [];

const execQuery = vi.fn((_env: any, sql: string, params: any[] = []) => {
  calls.push({ sql, params });
  return Promise.resolve(responses.shift() ?? { rows: [], rowCount: 0 });
});

const { findAll, findById, create, update, remove, checkDeleteRestrictions } = createCrud(execQuery as any);

const ENV = {} as any;

beforeEach(() => {
  calls.length = 0;
  responses = [];
  execQuery.mockClear();
});

describe('crud.findAll', () => {
  it('paginates: count query then data query with LIMIT/OFFSET', async () => {
    responses = [{ rows: [{ total: '42' }] }, { rows: [{ id: 1 }] }];
    const res = await findAll(ENV, { table: 'users', primaryKey: 'id', page: 3, limit: 10 });

    expect(calls[0].sql).toMatch(/SELECT COUNT\(\*\) as total FROM "users"/);
    // page 3, limit 10 -> LIMIT 10 OFFSET 20
    expect(calls[1].params.slice(-2)).toEqual([10, 20]);
    expect(res.pagination).toEqual({ total: 42, page: 3, pageSize: 10, totalPages: 5 });
    expect(res.rows).toEqual([{ id: 1 }]);
  });

  it('defaults order to primary key DESC when no sort given', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'orders', primaryKey: 'order_id' });
    expect(calls[1].sql).toContain('ORDER BY "orders".order_id DESC');
  });

  it('builds a case-insensitive OR search across searchFields on one param', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, {
      table: 'users', primaryKey: 'id', search: 'acme',
      searchFields: ['first_name', 'email'],
    });
    expect(calls[1].sql).toContain('LOWER("users".first_name) LIKE LOWER($1)');
    expect(calls[1].sql).toContain('OR LOWER("users".email) LIKE LOWER($1)');
    expect(calls[1].params[0]).toBe('%acme%');
  });

  it('translates sortBy camelCase to snake_case and clamps sortOrder', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'users', primaryKey: 'id', sortBy: 'firstName', sortOrder: 'asc' });
    expect(calls[1].sql).toContain('ORDER BY "users".first_name ASC');
  });

  it('filters tenant_id when tenantId provided', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'meter', primaryKey: 'meter_id', tenantId: 7 });
    expect(calls[0].sql).toContain('"meter".tenant_id = $1');
    expect(calls[0].params[0]).toBe(7);
  });

  it('emits IS NULL for a null where value (no param bound)', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'users', primaryKey: 'id', where: { deleted_at: null } });
    expect(calls[0].sql).toContain('"users".deleted_at IS NULL');
    expect(calls[0].params).toEqual([]);
  });

  it('exact-matches a where value', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'users', primaryKey: 'id', where: { active: true } });
    expect(calls[0].sql).toContain('"users".active = $1');
    expect(calls[0].params).toEqual([true]);
  });

  it('partial-matches a whereLike value, cast to text, AND\'ed with other conditions', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, {
      table: 'qb_customer', primaryKey: 'qb_customer_id',
      where: { is_active: true },
      whereLike: { phone: '71' },
    });
    expect(calls[0].sql).toContain('"qb_customer".is_active = $1');
    expect(calls[0].sql).toContain('LOWER("qb_customer".phone::text) LIKE LOWER($2)');
    expect(calls[0].params).toEqual([true, '%71%']);
  });

  it('skips an empty whereLike value', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'users', primaryKey: 'id', whereLike: { email: '' } });
    expect(calls[0].sql).not.toContain('LIKE');
    expect(calls[0].params).toEqual([]);
  });

  it('bounds a whereRange value with >= and <=, AND\'ed with other conditions', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, {
      table: 'qb_invoice', primaryKey: 'qb_invoice_id',
      where: { sales_rep_list_id: 'REP-1' },
      whereRange: { txn_date: { gte: '2026-09-01', lte: '2026-09-24' } },
    });
    expect(calls[0].sql).toContain('"qb_invoice".sales_rep_list_id = $1');
    expect(calls[0].sql).toContain('"qb_invoice".txn_date >= $2');
    expect(calls[0].sql).toContain('"qb_invoice".txn_date <= $3');
    expect(calls[0].params).toEqual(['REP-1', '2026-09-01', '2026-09-24']);
  });

  it('emits only the bound that is present in a whereRange entry', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, { table: 'qb_invoice', primaryKey: 'qb_invoice_id', whereRange: { txn_date: { gte: '2026-09-01' } } });
    expect(calls[0].sql).toContain('"qb_invoice".txn_date >= $1');
    expect(calls[0].sql).not.toContain('<=');
    expect(calls[0].params).toEqual(['2026-09-01']);
  });

  it('rejects an injection attempt in a whereRange key', async () => {
    await expect(
      findAll(ENV, { table: 'users', primaryKey: 'id', whereRange: { 'a; DROP TABLE users': { gte: 1 } } })
    ).rejects.toThrow(/Invalid whereRangeKey/);
  });

  it('excludes rows matching a whereNot value', async () => {
    responses = [{ rows: [{ total: '0' }] }, { rows: [] }];
    await findAll(ENV, {
      table: 'qb_invoice', primaryKey: 'qb_invoice_id',
      where: { qb_deleted_at: null },
      whereNot: { total: 0 },
    });
    expect(calls[0].sql).toContain('"qb_invoice".qb_deleted_at IS NULL');
    expect(calls[0].sql).toContain('"qb_invoice".total <> $1');
    expect(calls[0].params).toEqual([0]);
  });

  it('rejects an injection attempt in a whereNot key', async () => {
    await expect(
      findAll(ENV, { table: 'users', primaryKey: 'id', whereNot: { 'a; DROP TABLE users': 0 } })
    ).rejects.toThrow(/Invalid whereNotKey/);
  });

  it('rejects an injection attempt in the table name', async () => {
    await expect(
      findAll(ENV, { table: 'users; DROP TABLE users', primaryKey: 'id' })
    ).rejects.toThrow(/Invalid table/);
  });

  it('rejects an injection attempt in a search field', async () => {
    await expect(
      findAll(ENV, { table: 'users', primaryKey: 'id', search: 'x', searchFields: ['email OR 1=1'] })
    ).rejects.toThrow(/Invalid searchField/);
  });

  it('rejects an injection attempt in a whereLike key', async () => {
    await expect(
      findAll(ENV, { table: 'users', primaryKey: 'id', whereLike: { 'email OR 1=1': 'x' } })
    ).rejects.toThrow(/Invalid whereLikeKey/);
  });
});

describe('crud.findById', () => {
  it('selects by primary key and returns the row', async () => {
    responses = [{ rows: [{ id: 5 }] }];
    const row = await findById(ENV, 'users', 'id', 5);
    expect(calls[0].sql).toBe('SELECT "users".* FROM "users" WHERE id = $1');
    expect(row).toEqual({ id: 5 });
  });

  it('returns null when not found', async () => {
    responses = [{ rows: [] }];
    expect(await findById(ENV, 'users', 'id', 99)).toBeNull();
  });

  it('adds a tenant_id predicate when tenantId is passed', async () => {
    responses = [{ rows: [] }];
    await findById(ENV, 'meter', 'meter_id', 1, 7);
    expect(calls[0].sql).toContain('AND tenant_id = $2');
    expect(calls[0].params).toEqual([1, 7]);
  });

  it('inserts a joins fragment between FROM and WHERE when given', async () => {
    responses = [{ rows: [] }];
    await findById(
      ENV, 'qb_invoice', 'qb_invoice_id', 1, undefined,
      '"qb_invoice".*, qb_sales_rep.name AS sales_rep',
      'LEFT JOIN public.qb_sales_rep ON qb_sales_rep.list_id = "qb_invoice".sales_rep_list_id'
    );
    expect(calls[0].sql).toBe(
      'SELECT "qb_invoice".*, qb_sales_rep.name AS sales_rep FROM "qb_invoice" ' +
      'LEFT JOIN public.qb_sales_rep ON qb_sales_rep.list_id = "qb_invoice".sales_rep_list_id ' +
      'WHERE qb_invoice_id = $1'
    );
  });
});

describe('crud.create', () => {
  it('inserts only defined columns and returns the row', async () => {
    responses = [{ rows: [{ id: 1, name: 'A' }] }];
    const row = await create(ENV, 'users', { name: 'A', email: undefined });
    expect(calls[0].sql).toBe('INSERT INTO "users" (name) VALUES ($1) RETURNING *');
    expect(calls[0].params).toEqual(['A']);
    expect(row).toEqual({ id: 1, name: 'A' });
  });

  it('rejects an injected column name', async () => {
    await expect(create(ENV, 'users', { 'name); DROP': 'x' })).rejects.toThrow(/Invalid column/);
  });
});

describe('crud.update', () => {
  it('sets defined columns, excluding PK, touches updated_at by default, and binds id last', async () => {
    responses = [{ rows: [{ id: 5, name: 'B' }] }];
    const row = await update(ENV, 'users', 'id', 5, { name: 'B', id: 999 });
    expect(calls[0].sql).toBe('UPDATE "users" SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *');
    expect(calls[0].params).toEqual(['B', 5]);
    expect(row).toEqual({ id: 5, name: 'B' });
  });

  it('skips updated_at when touchUpdatedAt is false (tables with no such column)', async () => {
    responses = [{ rows: [{ id: 5, name: 'B' }] }];
    await update(ENV, 'users', 'id', 5, { name: 'B' }, { touchUpdatedAt: false });
    expect(calls[0].sql).toBe('UPDATE "users" SET name = $1 WHERE id = $2 RETURNING *');
  });

  it('never writes denylisted columns (tenant_id/created_at/updated_at)', async () => {
    responses = [{ rows: [{ id: 5 }] }];
    await update(ENV, 'users', 'id', 5, { name: 'B', tenant_id: 9, created_at: 'x', updated_at: 'y' });
    expect(calls[0].sql).toBe('UPDATE "users" SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *');
  });

  it('returns null without querying when there is nothing to update', async () => {
    const row = await update(ENV, 'users', 'id', 5, { id: 5, tenant_id: 9 });
    expect(row).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('crud.remove', () => {
  it('deletes by primary key and returns the removed row', async () => {
    responses = [{ rows: [{ id: 5 }] }];
    const row = await remove(ENV, 'users', 'id', 5);
    expect(calls[0].sql).toBe('DELETE FROM "users" WHERE id = $1 RETURNING *');
    expect(row).toEqual({ id: 5 });
  });

  it('returns null when nothing was deleted', async () => {
    responses = [{ rows: [] }];
    expect(await remove(ENV, 'users', 'id', 99)).toBeNull();
  });
});

describe('crud.checkDeleteRestrictions', () => {
  it('returns null when no children reference the row', async () => {
    responses = [{ rows: [{ count: 0 }] }];
    const v = await checkDeleteRestrictions(
      ENV, { deleteRestrictions: [{ table: 'quote', fk: 'user_id' }] }, 1
    );
    expect(v).toBeNull();
  });

  it('returns a violation with a pluralized message when children exist', async () => {
    responses = [{ rows: [{ count: 3 }] }];
    const v = await checkDeleteRestrictions(
      ENV, { deleteRestrictions: [{ table: 'quote_line', fk: 'user_id' }] }, 1
    );
    expect(v).toMatchObject({ table: 'quote_line', count: 3 });
    expect(v!.message).toContain('3 quote lines');
  });

  it('uses the singular form for exactly one child', async () => {
    responses = [{ rows: [{ count: 1 }] }];
    const v = await checkDeleteRestrictions(
      ENV, { deleteRestrictions: [{ table: 'quote', fk: 'user_id', label: 'quote' }] }, 1
    );
    expect(v!.message).toContain('1 quote ');
    expect(v!.message).not.toContain('1 quotes');
  });

  it('honors a custom override message', async () => {
    responses = [{ rows: [{ count: 2 }] }];
    const v = await checkDeleteRestrictions(
      ENV, { deleteRestrictions: [{ table: 'quote', fk: 'user_id', message: 'nope' }] }, 1
    );
    expect(v!.message).toBe('nope');
  });

  it('returns null when the schema has no restrictions', async () => {
    expect(await checkDeleteRestrictions(ENV, {}, 1)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('whereFromQuery', () => {
  it('splits reserved keys, exact-match fields, and likeFields', () => {
    const { where, whereLike } = whereFromQuery(
      { page: '2', limit: '25', search: 'x', sortBy: 'a', sortOrder: 'asc', approved: 'true', type: 'rep', phone: '71' },
      { likeFields: ['phone'] }
    );
    expect(where).toEqual({ approved: true, type: 'rep' });
    expect(whereLike).toEqual({ phone: '71' });
  });

  it('coerces "true"/"false" strings to real booleans for exact-match fields', () => {
    const { where } = whereFromQuery({ active: 'false' });
    expect(where).toEqual({ active: false });
  });

  it('drops empty-string values', () => {
    const { where, whereLike } = whereFromQuery({ type: '', phone: '' }, { likeFields: ['phone'] });
    expect(where).toEqual({});
    expect(whereLike).toEqual({});
  });

  it('drops route-specific extraReserved keys (e.g. one already folded into a security-scoped where)', () => {
    const { where } = whereFromQuery({ rep_id: 'abc', type: 'rep' }, { extraReserved: ['rep_id'] });
    expect(where).toEqual({ type: 'rep' });
  });

  it('rewrites a query key to its DB column via fieldMap, for both exact and like fields', () => {
    const { where, whereLike } = whereFromQuery(
      { isActive: 'true', displayName: 'bob' },
      { likeFields: ['displayName'], fieldMap: { isActive: 'isactive', displayName: 'display_name' } }
    );
    expect(where).toEqual({ isactive: true });
    expect(whereLike).toEqual({ display_name: 'bob' });
  });
});

describe('fieldMapFromSchema', () => {
  it('maps field name to dbField, skipping fields with no dbField', () => {
    const schema = {
      formFields: {
        isActive: { type: 'boolean', dbField: 'isactive' },
        virtualOnly: { type: 'object', dbField: null },
      },
    };
    expect(fieldMapFromSchema(schema)).toEqual({ isActive: 'isactive' });
  });
});

describe('likeFieldsFromSchema', () => {
  const schema = {
    formFields: {
      full_name: { type: 'string', showOn: ['list', 'form'] },
      phone: { type: 'string', showOn: ['list', 'form'] },
      upc_code: { type: 'string', showOn: ['form'] }, // not list-shown -> excluded
      type: { type: 'string', enumValues: ['rep', 'customer'], showOn: ['list', 'form'] }, // enum -> exact match
      is_active: { type: 'boolean', showOn: ['list', 'form'] }, // boolean -> exact match
      moq: { type: 'number', showOn: ['list', 'form'] },
      balance: { type: 'currency', showOn: ['list', 'form'] }, // not string/number -> excluded
    },
  };

  it('picks list-shown string/number fields with no enumValues', () => {
    expect(likeFieldsFromSchema(schema).sort()).toEqual(['full_name', 'moq', 'phone']);
  });

  it('unwraps a defineSchema() return value (schema.schema.formFields)', () => {
    expect(likeFieldsFromSchema({ schema } as any).sort()).toEqual(['full_name', 'moq', 'phone']);
  });
});
