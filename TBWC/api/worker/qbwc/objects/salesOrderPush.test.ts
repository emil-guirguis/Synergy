/**
 * SalesOrder push (memo -> QB) failure reporting: the sync log must name the
 * order by its QB order number and say what the operator should do, not echo
 * QB's raw "edit sequence is out-of-date" jargon.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: { sql: string; params: any[]; label?: string }[] = [];
let responses: any[] = [];

vi.mock('../../db', () => ({
  execQuery: vi.fn((_env: any, sql: string, params: any[] = [], label?: string) => {
    calls.push({ sql, params, label });
    return Promise.resolve(responses.shift() ?? { rows: [], rowCount: 0 });
  }),
}));

const logDetail = vi.fn<(...args: any[]) => Promise<void>>(async () => {});
vi.mock('../syncLog', () => ({
  logDetail: (...args: any[]) => logDetail(...args),
  DETAIL_LOG_LIMIT: 25,
}));

vi.mock('../orderInvoiceStatus', () => ({ refreshOrderInvoiceStatus: vi.fn(async () => {}) }));
vi.mock('../incremental', () => ({ pullSince: vi.fn(async () => null) }));

import salesOrder from './salesOrder';

const ENV = {} as any;
const TXN = '77407-1793193028';

/** One failed SalesOrderModRs, as QB sends it (statusMessage XML-escaped). */
function modRs(statusCode: string, statusMessage: string): string {
  return `<QBXML><QBXMLMsgsRs><SalesOrderModRs requestID="salesorder:mod:${TXN}" ` +
    `statusCode="${statusCode}" statusSeverity="Error" statusMessage="${statusMessage}">` +
    `</SalesOrderModRs></QBXMLMsgsRs></QBXML>`;
}

const STALE = 'The provided edit sequence &quot;1793292655&quot; is out-of-date.';

beforeEach(() => {
  calls.length = 0;
  logDetail.mockClear();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('SalesOrderMod push failures', () => {
  it('names the order number and explains 3200 as a retry, not a failure', async () => {
    responses = [
      { rows: [{ txn_id: TXN, field_name: 'memo', new_value: 'x', status: 'pending' }], rowCount: 1 },
      { rows: [{ ref_number: 'TBWC 5769' }], rowCount: 1 },
      { rows: [], rowCount: 1 }, // markFailed
    ];
    await salesOrder.parseResponse(ENV, modRs('3200', STALE));

    const [, , direction, detail, error] = logDetail.mock.calls[0];
    expect(direction).toBe('push');
    expect(detail).toContain('TBWC 5769');
    expect(detail).toContain('memo');
    expect(detail).not.toContain('edit sequence');
    expect(error).toBeNull(); // self-healing: the next session resends it
    expect(calls.some((c) => c.label === 'qbwc.so.refNumberForPush')).toBe(true);
  });

  it('reports a real error once the same edit has already been retried', async () => {
    responses = [
      { rows: [{ txn_id: TXN, field_name: 'memo', new_value: 'x', status: 'failed' }], rowCount: 1 },
      { rows: [{ ref_number: 'TBWC 5769' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ];
    await salesOrder.parseResponse(ENV, modRs('3200', STALE));

    const error = logDetail.mock.calls[0][4] as string;
    expect(error).toContain('TBWC 5769');
    expect(error).toContain('3200');
    expect(error).toContain('keeps changing in QuickBooks');
  });

  it('passes a non-3200 QB message through, unescaped and with the order number', async () => {
    responses = [
      { rows: [{ txn_id: TXN, field_name: 'memo', new_value: 'x', status: 'pending' }], rowCount: 1 },
      { rows: [{ ref_number: 'TBWC 5769' }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ];
    await salesOrder.parseResponse(ENV, modRs('3120', 'Object &quot;ABC&quot; specified in the request cannot be found.'));

    const error = logDetail.mock.calls[0][4] as string;
    expect(error).toContain('Order TBWC 5769');
    expect(error).toContain('Object "ABC" specified in the request cannot be found.');
    expect(error).toContain('QuickBooks code 3120');
  });

  it('falls back to the TxnID when the order is not synced locally yet', async () => {
    responses = [
      { rows: [{ txn_id: TXN, field_name: 'memo', new_value: 'x', status: 'pending' }], rowCount: 1 },
      { rows: [], rowCount: 0 }, // no qb_sales_order row
      { rows: [], rowCount: 1 },
    ];
    await salesOrder.parseResponse(ENV, modRs('3200', STALE));
    expect(logDetail.mock.calls[0][3]).toContain(TXN);
  });
});
