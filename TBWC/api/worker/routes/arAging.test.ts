/**
 * AR Aging report. The row scope guard itself is asserted across every report
 * in reportScope.test.ts; here the subject is the banding — that the three
 * bands are disjoint, contiguous and exhaustive, that only open past-due
 * invoices are counted, that the customer filter narrows every figure, and
 * that each card comes back with the bounds the frontend needs to drill into
 * /invoices?days_past_due=<min>&days_past_due_max=<max>.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentPermSet = new Set(['arAging:read']);
let currentScope: 'all' | 'own' = 'all';

vi.mock('../middleware', () => ({
  authenticateToken: (c: any, next: any) => {
    c.set('user', { id: 'admin' });
    c.set('userId', 'admin');
    return next();
  },
  requirePermission: (permission: string) => (c: any, next: any) => {
    if (!currentPermSet.has(permission)) {
      return c.json({ success: false, message: 'Insufficient permissions' }, 403);
    }
    c.set('permissions', { scopeOf: () => currentScope });
    return next();
  },
  reportRepScope: (c: any, permission: string) =>
    c.get('permissions')?.scopeOf(permission) === 'own' ? ['REP1'] : null,
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import arAgingApp, { AGING_BANDS } from './arAging';

const ENV = {} as any;
const req = (path: string) => arAgingApp.request(path, undefined, ENV);

/** One consistent set of figures: the four bands sum to the headline. */
const FIGURES = {
  count_all: 10, total_all: '5000.00',
  count_1: 4, total_1: '2000.00',
  count_31: 3, total_31: '1500.00',
  count_61: 2, total_61: '500.00',
  count_91: 1, total_91: '1000.00',
};

beforeEach(() => {
  vi.clearAllMocks();
  currentPermSet = new Set(['arAging:read']);
  currentScope = 'all';
  mockExecQuery.mockResolvedValue({ rows: [{}] });
});

describe('permission gate', () => {
  it('403s without arAging:read', async () => {
    currentPermSet = new Set();
    const res = await req('/summary');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('GET /summary', () => {
  it('counts only open invoices already past their due date', async () => {
    await req('/summary');
    const sql = mockExecQuery.mock.calls[0][1];
    expect(sql).toContain('COALESCE(balance_remaining, 0) > 0');
    expect(sql).toContain('due_date < CURRENT_DATE');
    expect(sql).toContain('due_date IS NOT NULL');
    // Same exclusions as the Invoices list the cards open, so the counts reconcile.
    expect(sql).toContain('qb_deleted_at IS NULL');
    expect(sql).toContain('NOT is_packing_slip');
  });

  it('bands disjointly — each invoice lands in exactly one', async () => {
    await req('/summary');
    const sql = mockExecQuery.mock.calls[0][1];
    expect(sql).toContain('days_late BETWEEN 1 AND 30');
    expect(sql).toContain('days_late BETWEEN 31 AND 60');
    expect(sql).toContain('days_late BETWEEN 61 AND 90');
    // Only the tail is open-ended.
    expect(sql).toContain('days_late >= 91');
    expect(sql).not.toContain('days_late >= 30');
    expect(sql).not.toContain('days_late >= 60');
    expect(sql).not.toContain('days_late >= 90 ');
  });

  it('declares contiguous, non-overlapping, exhaustive bands', async () => {
    // Starts at day 1, so no past-due invoice falls outside the bands.
    expect(AGING_BANDS[0].minDays).toBe(1);
    for (let i = 1; i < AGING_BANDS.length; i++) {
      const prev = AGING_BANDS[i - 1];
      expect(prev.maxDays).not.toBeNull();
      // No gap and no overlap: the next band starts the day after the last ends.
      expect(AGING_BANDS[i].minDays).toBe(prev.maxDays! + 1);
    }
    expect(AGING_BANDS[AGING_BANDS.length - 1].maxDays).toBeNull();
  });

  it('sums the open balance, never the invoice total', async () => {
    await req('/summary');
    const sql = mockExecQuery.mock.calls[0][1];
    expect(sql).toContain('SUM(balance_remaining)');
    expect(sql).not.toContain('SUM(total)');
  });

  it('returns each band with the bounds the drill-down link needs', async () => {
    mockExecQuery.mockResolvedValue({ rows: [FIGURES] });
    const res = await req('/summary');
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.pastDue).toEqual({ minDays: 1, maxDays: null, count: 10, total: 5000 });
    expect(data.buckets).toEqual([
      { minDays: 1, maxDays: 30, count: 4, total: 2000 },
      { minDays: 31, maxDays: 60, count: 3, total: 1500 },
      { minDays: 61, maxDays: 90, count: 2, total: 500 },
      { minDays: 91, maxDays: null, count: 1, total: 1000 },
    ]);
  });

  it('reports bands that add up to the 1+ day total exactly', async () => {
    mockExecQuery.mockResolvedValue({ rows: [FIGURES] });
    const { data } = await (await req('/summary')).json();
    const banded = data.buckets.reduce((sum: number, b: any) => sum + b.total, 0);
    const counted = data.buckets.reduce((sum: number, b: any) => sum + b.count, 0);
    // Exhaustive and non-overlapping: anything else means a gap or a
    // double-count in the band definitions.
    expect(banded).toBe(data.pastDue.total);
    expect(counted).toBe(data.pastDue.count);
  });

  it('reports zeros rather than nulls when nothing is past due', async () => {
    mockExecQuery.mockResolvedValue({ rows: [] });
    const res = await req('/summary');
    const { data } = await res.json();
    expect(data.pastDue).toEqual({ minDays: 1, maxDays: null, count: 0, total: 0 });
    expect(data.buckets.map((b: any) => b.total)).toEqual([0, 0, 0, 0]);
  });

  it('narrows to the caller\'s reps at own scope', async () => {
    currentScope = 'own';
    await req('/summary');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([['REP1'], null]);
  });

  it('passes a null rep filter at all scope', async () => {
    await req('/summary');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, null]);
  });
});

describe('GET /invoices (the report table)', () => {
  it('403s without arAging:read', async () => {
    currentPermSet = new Set();
    const res = await req('/invoices');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });

  it('selects every column the table renders', async () => {
    await req('/invoices');
    const sql = mockExecQuery.mock.calls[0][1];
    for (const column of [
      'customer_name', 'balance_remaining', 'ref_number', 'txn_date', 'due_date',
      'notice_1_date', 'notice_2_date', 'notice_3_date',
      'days_since_invoice', 'days_past_due', 'late_fee_applied', 'ar_notes',
    ]) {
      expect(sql, `missing ${column}`).toContain(column);
    }
    // Without `id` a row click opens nothing — the invoice form fetches by it.
    expect(sql).toContain('AS id');
    // ADP joined per customer, not run once per row.
    expect(sql).toContain('LEFT JOIN adp');
  });

  it('uses the same past-due predicate as the figures above it', async () => {
    await req('/invoices');
    const sql = mockExecQuery.mock.calls[0][1];
    expect(sql).toContain('i.qb_deleted_at IS NULL');
    expect(sql).toContain('NOT i.is_packing_slip');
    expect(sql).toContain('i.due_date < CURRENT_DATE');
    expect(sql).toContain('COALESCE(i.balance_remaining, 0) > 0');
  });

  it('binds a clicked band as inclusive day bounds', async () => {
    await req('/invoices?minDays=31&maxDays=60');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('>= $3');
    expect(sql).toContain('<= $4');
    expect(params).toEqual([null, null, 31, 60]);
  });

  it('leaves the open-ended band without an upper bound', async () => {
    await req('/invoices?minDays=91');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, null, 91, null]);
  });

  it('returns every past-due invoice when no band is selected', async () => {
    await req('/invoices');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, null, null, null]);
  });

  it('ignores non-numeric day bounds rather than binding them', async () => {
    await req('/invoices?minDays=soon&maxDays=later');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, null, null, null]);
  });

  it('applies the customer filter alongside the band', async () => {
    await req('/invoices?customerListId=CUST-1&minDays=1&maxDays=30');
    expect(mockExecQuery.mock.calls[0][2]).toEqual([null, 'CUST-1', 1, 30]);
  });

  it('narrows to the caller\'s reps at own scope', async () => {
    currentScope = 'own';
    await req('/invoices');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('= ANY($1::text[])');
    expect(params[0]).toEqual(['REP1']);
  });

  it('caps the payload rather than returning an unbounded result set', async () => {
    await req('/invoices');
    const sql = mockExecQuery.mock.calls[0][1];
    expect(sql).toMatch(/LIMIT \d+/);
  });

  it('returns the rows under `items`', async () => {
    mockExecQuery.mockResolvedValue({ rows: [{ id: 1, ref_number: '10148' }] });
    const { data } = await (await req('/invoices')).json();
    expect(data.items).toEqual([{ id: 1, ref_number: '10148' }]);
  });
});

describe('customer filter', () => {
  it('narrows the figures to one customer', async () => {
    await req('/summary?customerListId=CUST-1');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('customer_list_id = $2');
    expect(params).toEqual([null, 'CUST-1']);
  });

  it('echoes the selected customer back for the dropdown', async () => {
    const { data } = await (await req('/summary?customerListId=CUST-1')).json();
    expect(data.customerListId).toBe('CUST-1');
  });

  it('is null when no customer is selected', async () => {
    const { data } = await (await req('/summary')).json();
    expect(data.customerListId).toBeNull();
  });

  it('offers only customers that actually have something past due', async () => {
    await req('/summary');
    const optionsSql = mockExecQuery.mock.calls[1][1];
    expect(optionsSql).toContain('FROM public.qb_invoice');
    expect(optionsSql).toContain('due_date < CURRENT_DATE');
    expect(optionsSql).toContain('COALESCE(balance_remaining, 0) > 0');
  });

  it('scopes the dropdown the same way the figures are scoped', async () => {
    currentScope = 'own';
    await req('/summary');
    expect(mockExecQuery.mock.calls[1][2]).toEqual([['REP1']]);
  });

  it('never lets the customer filter widen the rep scope', async () => {
    currentScope = 'own';
    await req('/summary?customerListId=CUST-1');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('= ANY($1::text[])');
    expect(params[0]).toEqual(['REP1']);
  });
});
