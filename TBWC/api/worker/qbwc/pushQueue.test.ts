import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecQuery = vi.fn<(env: any, sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number }>>(
  async () => ({ rows: [], rowCount: 0 })
);
vi.mock('../db', () => ({ execQuery: (env: any, sql: string, params?: any[]) => mockExecQuery(env, sql, params) }));

import { queueFieldPush, pendingPushes, pendingValue, markPushed, markFailed } from './pushQueue';

const ENV = {} as any;

beforeEach(() => {
  mockExecQuery.mockClear();
  mockExecQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('queueFieldPush', () => {
  it('upserts on the (object_type, txn_id, field_name) key, resetting status and error', async () => {
    await queueFieldPush(ENV, 'SalesOrder', 'TXN-1', 'memo', 'new memo');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO public\.qbwc_push_queue/);
    expect(sql).toMatch(/ON CONFLICT \(object_type, txn_id, field_name\) DO UPDATE/);
    expect(params).toEqual(['SalesOrder', 'TXN-1', 'memo', 'new memo']);
  });

  it('accepts a null value (clearing a field)', async () => {
    await queueFieldPush(ENV, 'SalesOrder', 'TXN-1', 'memo', null);
    expect(mockExecQuery.mock.calls[0][2]).toEqual(['SalesOrder', 'TXN-1', 'memo', null]);
  });
});

describe('pendingPushes', () => {
  it('selects pending and failed rows for the object type', async () => {
    mockExecQuery.mockResolvedValueOnce({
      rows: [{ txn_id: 'TXN-1', field_name: 'memo', new_value: 'x' }], rowCount: 1,
    });
    const rows = await pendingPushes(ENV, 'SalesOrder');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toMatch(/status IN \('pending', 'failed'\)/);
    expect(params).toEqual(['SalesOrder']);
    expect(rows).toEqual([{ txn_id: 'TXN-1', field_name: 'memo', new_value: 'x' }]);
  });
});

describe('pendingValue', () => {
  it('returns the queued value when one is pending', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [{ new_value: 'queued' }], rowCount: 1 });
    expect(await pendingValue(ENV, 'SalesOrder', 'TXN-1', 'memo')).toBe('queued');
  });

  it('returns null when nothing is queued', async () => {
    mockExecQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await pendingValue(ENV, 'SalesOrder', 'TXN-1', 'memo')).toBeNull();
  });
});

describe('markPushed', () => {
  it('deletes the named fields for that record', async () => {
    await markPushed(ENV, 'SalesOrder', 'TXN-1', ['memo', 'notes']);
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM public\.qbwc_push_queue/);
    expect(params).toEqual(['SalesOrder', 'TXN-1', ['memo', 'notes']]);
  });

  it('is a no-op for an empty field list', async () => {
    await markPushed(ENV, 'SalesOrder', 'TXN-1', []);
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});

describe('markFailed', () => {
  it('sets status to failed with the error message, keeping the row for retry', async () => {
    await markFailed(ENV, 'SalesOrder', 'TXN-1', ['memo'], 'QB rejected the edit');
    const [, sql, params] = mockExecQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE public\.qbwc_push_queue SET status = 'failed'/);
    expect(params).toEqual(['SalesOrder', 'TXN-1', ['memo'], 'QB rejected the edit']);
  });

  it('is a no-op for an empty field list', async () => {
    await markFailed(ENV, 'SalesOrder', 'TXN-1', [], 'unused');
    expect(mockExecQuery).not.toHaveBeenCalled();
  });
});
