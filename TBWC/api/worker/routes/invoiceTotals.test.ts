import { describe, it, expect, vi, beforeEach } from 'vitest';

let currentPermSet = new Set(['report:read']);

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
    return next();
  },
}));

const mockExecQuery = vi.fn();
vi.mock('../db', () => ({
  execQuery: (...a: any[]) => mockExecQuery(...a),
}));

import invoiceTotalsApp, { periodWindows, parseCustomRange } from './invoiceTotals';

const ENV = {} as any;
const req = (path: string) => invoiceTotalsApp.request(path, undefined, ENV);

beforeEach(() => {
  vi.clearAllMocks();
  currentPermSet = new Set(['report:read']);
  mockExecQuery.mockResolvedValue({ rows: [] });
});

describe('permission gate', () => {
  it('403s without report:read', async () => {
    currentPermSet = new Set();
    const res = await req('/timeseries');
    expect(res.status).toBe(403);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('periodWindows', () => {
  it('day: current is today; previous is yesterday; prior-year is the same calendar day last year', () => {
    const w = periodWindows('day', new Date('2026-09-24T12:00:00Z'));
    expect(w).toEqual({
      currentStart: '2026-09-24',
      currentEnd: '2026-09-24',
      previousStart: '2026-09-23',
      previousEnd: '2026-09-23',
      priorYearStart: '2025-09-24',
      priorYearEnd: '2025-09-24',
    });
  });

  it('week: current starts on the most recent Friday; previous is 7d back; prior-year is 364d back', () => {
    // Thursday 2026-09-24 -> current week started Friday 2026-09-18.
    const w = periodWindows('week', new Date('2026-09-24T12:00:00Z'));
    expect(w).toEqual({
      currentStart: '2026-09-18',
      currentEnd: '2026-09-24',
      previousStart: '2026-09-11',
      previousEnd: '2026-09-17',
      priorYearStart: '2025-09-19', // 2026-09-18 - 364d, still a Friday
      priorYearEnd: '2025-09-25', // 2026-09-24 - 364d
    });
  });

  it('month: current-month-to-date vs last month vs same month/day last year', () => {
    const w = periodWindows('month', new Date('2026-09-24T12:00:00Z'));
    expect(w).toEqual({
      currentStart: '2026-09-01',
      currentEnd: '2026-09-24',
      previousStart: '2026-08-01',
      previousEnd: '2026-08-24',
      priorYearStart: '2025-09-01',
      priorYearEnd: '2025-09-24',
    });
  });

  it('quarter: current-quarter-to-date vs last quarter vs same quarter/day last year', () => {
    // Sept is in Q3 (Jul-Sep) -> quarter start Jul 1; last quarter is Q2 (Apr-Jun).
    const w = periodWindows('quarter', new Date('2026-09-24T12:00:00Z'));
    expect(w).toEqual({
      currentStart: '2026-07-01',
      currentEnd: '2026-09-24',
      previousStart: '2026-04-01',
      previousEnd: '2026-06-24',
      priorYearStart: '2025-07-01',
      priorYearEnd: '2025-09-24',
    });
  });

  it('year: YTD vs last year vs prior-year same-day-of-year — previous and priorYear coincide', () => {
    const w = periodWindows('year', new Date('2026-09-24T12:00:00Z'));
    expect(w).toEqual({
      currentStart: '2026-01-01',
      currentEnd: '2026-09-24',
      previousStart: '2025-01-01',
      previousEnd: '2025-09-24',
      priorYearStart: '2025-01-01',
      priorYearEnd: '2025-09-24',
    });
  });

  it('custom: previous is an equal-length range immediately before; priorYear shifts both ends a year back', () => {
    const w = periodWindows('custom', new Date('2026-09-24T12:00:00Z'), {
      from: new Date('2026-09-10T00:00:00Z'),
      to: new Date('2026-09-24T00:00:00Z'),
    });
    // 15-day range (10th..24th inclusive) -> previous is the 15 days right before it.
    expect(w).toEqual({
      currentStart: '2026-09-10',
      currentEnd: '2026-09-24',
      previousStart: '2026-08-26',
      previousEnd: '2026-09-09',
      priorYearStart: '2025-09-10',
      priorYearEnd: '2025-09-24',
    });
  });
});

describe('parseCustomRange', () => {
  const now = new Date('2026-09-24T12:00:00Z');

  it('defaults to the last 30 days when neither bound is given', () => {
    const r = parseCustomRange(undefined, undefined, now);
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-08-26'); // 30 days inclusive
  });

  it('uses the given from/to as-is when within the span cap', () => {
    const r = parseCustomRange('2026-09-01', '2026-09-10', now);
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-09-10');
  });

  it('swaps a reversed from/to pair', () => {
    const r = parseCustomRange('2026-09-10', '2026-09-01', now);
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-09-01');
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-09-10');
  });

  it('caps an oversized span at 366 days by pulling `from` forward', () => {
    const r = parseCustomRange('2020-01-01', '2026-09-24', now);
    const spanDays = Math.round((r.to.getTime() - r.from.getTime()) / 86400000);
    expect(spanDays).toBe(366);
    expect(r.to.toISOString().slice(0, 10)).toBe('2026-09-24');
  });

  it('ignores a malformed date and falls back to the default', () => {
    const r = parseCustomRange('not-a-date', undefined, now);
    expect(r.from.toISOString().slice(0, 10)).toBe('2026-08-26');
  });
});

describe('GET /summary', () => {
  it('queries current/previous/priorYear windows and returns reps, no year param', async () => {
    mockExecQuery
      .mockResolvedValueOnce({
        rows: [{
          current_total: '100.00', current_count: 2,
          previous_total: '80.00', previous_count: 3,
          prior_year_total: '50.00', prior_year_count: 1,
        }],
      })
      .mockResolvedValueOnce({ rows: [{ list_id: 'REP-1', name: 'Rep One' }] });

    const res = await req('/summary?period=month');
    const body = await res.json();

    expect(body.data.period).toBe('month');
    expect(body.data.reps).toEqual([{ list_id: 'REP-1', name: 'Rep One' }]);
    expect(body.data.current).toMatchObject({ total: 100, count: 2 });
    expect(body.data.previous).toMatchObject({ total: 80, count: 3 });
    expect(body.data.priorYear).toMatchObject({ total: 50, count: 1 });
    // Every card carries the exact date range that produced it, for the
    // frontend's click-through to the Invoices list.
    expect(body.data.current.from).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
    expect(body.data.current.to).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it('passes repId through as the 7th query param', async () => {
    await req('/summary?period=year&repId=REP-9');
    const [, , params] = mockExecQuery.mock.calls[0];
    expect(params[6]).toBe('REP-9');
  });

  it('excludes total=0 invoices from every window', async () => {
    await req('/summary?period=week');
    const [, sql] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('AND total <> 0');
  });

  it('defaults to week for an unrecognized period', async () => {
    await req('/summary?period=bogus');
    // no throw, and reps query still runs
    expect(mockExecQuery).toHaveBeenCalledTimes(2);
  });

  it('period=custom uses the given from/to as the current window', async () => {
    mockExecQuery
      .mockResolvedValueOnce({ rows: [{ current_total: '10', current_count: 1, previous_total: '0', previous_count: 0, prior_year_total: '0', prior_year_count: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
    await req('/summary?period=custom&from=2026-09-01&to=2026-09-10');
    const [, , params] = mockExecQuery.mock.calls[0];
    expect(params[0]).toBe('2026-09-01');
    expect(params[1]).toBe('2026-09-10');
  });
});

describe('GET /timeseries', () => {
  it('adds a plain-date bucket expression for day', async () => {
    await req('/timeseries?period=day');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('txn_date::date');
    expect(params).toEqual([null, 30]);
  });

  it('caps an oversized day limit at its max', async () => {
    await req('/timeseries?period=day&limit=999');
    const [, , params] = mockExecQuery.mock.calls[0];
    expect(params).toEqual([null, 180]);
  });

  it('adds a quarter bucket expression', async () => {
    await req('/timeseries?period=quarter');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain("date_trunc('quarter', txn_date)");
    expect(params).toEqual([null, 8]);
  });

  it('caps an oversized quarter limit at its max', async () => {
    await req('/timeseries?period=quarter&limit=999');
    const [, , params] = mockExecQuery.mock.calls[0];
    expect(params).toEqual([null, 40]);
  });

  it('still defaults to weekly buckets with the Friday-anchor expression', async () => {
    await req('/timeseries');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain("date_trunc('week', txn_date - interval '4 days') + interval '4 days'");
    expect(params).toEqual([null, 26]);
  });

  it('period=custom buckets by day across the given from/to, no LIMIT', async () => {
    await req('/timeseries?period=custom&from=2026-09-01&to=2026-09-10&repId=REP-2');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('txn_date::date AS bucket_start');
    expect(sql).not.toContain('LIMIT');
    expect(sql).toContain('AND total <> 0');
    expect(params).toEqual(['2026-09-01', '2026-09-10', 'REP-2']);
  });

  it('excludes total=0 invoices for a fixed granularity too', async () => {
    await req('/timeseries?period=week');
    const [, sql] = mockExecQuery.mock.calls[0];
    expect(sql).toContain('AND total <> 0');
  });

  it('shapes rows into bucketStart/total/count points', async () => {
    mockExecQuery.mockResolvedValue({
      rows: [{ bucket_start: '2026-09-18', total: '1234.50', count: 3 }],
    });
    const res = await req('/timeseries');
    const body = await res.json();
    expect(body.data).toEqual({
      period: 'week',
      repId: null,
      points: [{ bucketStart: '2026-09-18', total: 1234.5, count: 3 }],
    });
  });
});
