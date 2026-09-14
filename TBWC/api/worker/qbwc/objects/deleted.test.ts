/**
 * QB-side deletion sweeps: txnDeleted (SalesOrder/Invoice) and listDeleted
 * (Customer/SalesRep/Item*). Both are soft-delete only, both route a mixed
 * response to the right staging table, and both must stay quiet about a type
 * we don't stage.
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

const refreshOrderInvoiceStatus = vi.fn(async () => {});
vi.mock('../orderInvoiceStatus', () => ({
  refreshOrderInvoiceStatus: () => refreshOrderInvoiceStatus(),
}));

import txnDeleted from './txnDeleted';
import listDeleted from './listDeleted';

const ENV = {} as any;

/** Just the soft-delete statements — logging goes through its own mock. */
const updates = () => calls.filter((c) => /UPDATE/.test(c.sql));

beforeEach(() => {
  calls.length = 0;
  responses = [];
  logDetail.mockClear();
  refreshOrderInvoiceStatus.mockClear();
});

describe('txnDeleted', () => {
  it('asks for every transaction type in one doc, one Rq per type', async () => {
    const rq = await txnDeleted.buildRequest(ENV);
    expect(rq).toContain('<TxnDeletedQueryRq requestID="txndeleted:SalesOrder">');
    expect(rq).toContain('<TxnDeletedQueryRq requestID="txndeleted:Invoice">');
    expect(rq).toContain('<TxnDelType>SalesOrder</TxnDelType>');
    expect(rq).toContain('<TxnDelType>Invoice</TxnDelType>');
    // Prefix-matched by dispatchResponse, so the whole payload lands back here.
    expect(rq.match(/requestID="txndeleted:/g)).toHaveLength(2);
  });

  it('soft-deletes each type into its own table and logs one line per record', async () => {
    responses = [
      { rows: [{ txn_id: 'SO1', label: 'TBWC 5687' }], rowCount: 1 }, // sales order update
      { rows: [{ txn_id: 'IN1', label: '9001' }], rowCount: 1 },      // invoice update
    ];
    // Two Rs blocks, as the per-type requests come back.
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs requestID="txndeleted:SalesOrder" statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>SalesOrder</TxnDelType><TxnID>SO1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>' +
      '<TxnDeletedQueryRs requestID="txndeleted:Invoice" statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>Invoice</TxnDelType><TxnID>IN1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');

    const u = updates();
    expect(u).toHaveLength(2);
    expect(u[0].sql).toMatch(/UPDATE public\.qb_sales_order SET qb_deleted_at/);
    expect(u[0].sql).toMatch(/qb_deleted_at IS NULL/); // re-running a session is a no-op
    expect(u[0].params[0]).toEqual(['SO1']);
    expect(u[1].sql).toMatch(/UPDATE public\.qb_invoice SET qb_deleted_at/);
    expect(u[1].params[0]).toEqual(['IN1']);
    expect(logDetail.mock.calls.map((c: any[]) => c[3]))
      .toEqual(['Deleted order TBWC 5687', 'Deleted invoice 9001']);
  });

  it('recomputes order invoice status only when an invoice was newly marked', async () => {
    responses = [{ rows: [{ txn_id: 'SO1', label: 'TBWC 1' }], rowCount: 1 }];
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>SalesOrder</TxnDelType><TxnID>SO1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');
    expect(refreshOrderInvoiceStatus).not.toHaveBeenCalled();

    responses = [{ rows: [{ txn_id: 'IN1', label: '9001' }], rowCount: 1 }];
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>Invoice</TxnDelType><TxnID>IN1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');
    expect(refreshOrderInvoiceStatus).toHaveBeenCalledTimes(1);
  });

  it('logs and recomputes nothing when the rows were already marked', async () => {
    responses = [{ rows: [], rowCount: 0 }];
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>Invoice</TxnDelType><TxnID>IN1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');
    expect(logDetail).not.toHaveBeenCalled();
    expect(refreshOrderInvoiceStatus).not.toHaveBeenCalled();
  });

  it('ignores types we do not stage, and empty or failed responses', async () => {
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>Bill</TxnDelType><TxnID>B1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');
    await txnDeleted.parseResponse(ENV, '<TxnDeletedQueryRs statusCode="1"/>');
    await txnDeleted.parseResponse(ENV, '<TxnDeletedQueryRs statusCode="3200"/>');
    expect(updates()).toHaveLength(0);
  });

  it('still processes the blocks that succeeded when one type is refused', async () => {
    responses = [{ rows: [{ txn_id: 'IN1', label: '9001' }], rowCount: 1 }];
    await txnDeleted.parseResponse(ENV,
      '<TxnDeletedQueryRs requestID="txndeleted:SalesOrder" statusCode="3100" statusMessage="nope"/>' +
      '<TxnDeletedQueryRs requestID="txndeleted:Invoice" statusCode="0">' +
      '<TxnDeletedRet><TxnDelType>Invoice</TxnDelType><TxnID>IN1</TxnID></TxnDeletedRet>' +
      '</TxnDeletedQueryRs>');

    const u = updates();
    expect(u).toHaveLength(1);
    expect(u[0].sql).toMatch(/UPDATE public\.qb_invoice/);
  });
});

describe('listDeleted', () => {
  it('asks for the list types we stage, item sub-types included, one Rq each', async () => {
    const rq = await listDeleted.buildRequest(ENV);
    const types = ['Customer', 'SalesRep', 'ItemService', 'ItemInventory',
      'ItemNonInventory', 'ItemOtherCharge', 'ItemInventoryAssembly', 'ItemDiscount'];
    for (const t of types) {
      expect(rq).toContain('<ListDeletedQueryRq requestID="listdeleted:' + t + '">');
      expect(rq).toContain('<ListDelType>' + t + '</ListDelType>');
    }
    expect(rq.match(/requestID="listdeleted:/g)).toHaveLength(types.length);
  });

  it('collapses every item sub-type into one qb_item update', async () => {
    responses = [{ rows: [{ list_id: 'I1', label: 'TB-1000' }, { list_id: 'I2', label: 'TB-2000' }], rowCount: 2 }];
    await listDeleted.parseResponse(ENV,
      '<ListDeletedQueryRs statusCode="0">' +
      '<ListDeletedRet><ListDelType>ItemInventory</ListDelType><ListID>I1</ListID></ListDeletedRet>' +
      '<ListDeletedRet><ListDelType>ItemService</ListDelType><ListID>I2</ListID></ListDeletedRet>' +
      '</ListDeletedQueryRs>');

    const u = updates();
    expect(u).toHaveLength(1);
    expect(u[0].sql).toMatch(/UPDATE public\.qb_item SET qb_deleted_at/);
    expect(u[0].params[0]).toEqual(['I1', 'I2']);
  });

  it('routes customers and sales reps to their own tables, keyed by list_id', async () => {
    responses = [
      { rows: [{ list_id: 'C1', label: 'Acme' }], rowCount: 1 },
      { rows: [{ list_id: 'R1', label: 'Bob Wilson' }], rowCount: 1 },
    ];
    await listDeleted.parseResponse(ENV,
      '<ListDeletedQueryRs statusCode="0">' +
      '<ListDeletedRet><ListDelType>Customer</ListDelType><ListID>C1</ListID></ListDeletedRet>' +
      '<ListDeletedRet><ListDelType>SalesRep</ListDelType><ListID>R1</ListID></ListDeletedRet>' +
      '</ListDeletedQueryRs>');

    const u = updates();
    expect(u.map((x) => x.sql.match(/UPDATE (public\.\w+)/)![1]))
      .toEqual(['public.qb_customer', 'public.qb_sales_rep']);
    expect(u.every((x) => /WHERE list_id = ANY\(\$1\)/.test(x.sql))).toBe(true);
    expect(logDetail.mock.calls.map((c: any[]) => c[3]))
      .toEqual(['Deleted customer Acme', 'Deleted sales rep Bob Wilson']);
  });

  it('summarises instead of logging a line per record past the cap', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ list_id: 'I' + i, label: 'TB-' + i }));
    responses = [{ rows, rowCount: rows.length }];
    await listDeleted.parseResponse(ENV,
      '<ListDeletedQueryRs statusCode="0">' +
      rows.map((r) => '<ListDeletedRet><ListDelType>ItemInventory</ListDelType><ListID>' + r.list_id + '</ListID></ListDeletedRet>').join('') +
      '</ListDeletedQueryRs>');

    expect(logDetail).toHaveBeenCalledTimes(1);
    expect(logDetail.mock.calls[0][3]).toBe('Deleted 30 items in QuickBooks');
    expect(logDetail.mock.calls[0][5]).toBe(30); // rows_processed on the summary row
  });

  it('ignores list types we do not stage', async () => {
    await listDeleted.parseResponse(ENV,
      '<ListDeletedQueryRs statusCode="0">' +
      '<ListDeletedRet><ListDelType>Vendor</ListDelType><ListID>V1</ListID></ListDeletedRet>' +
      '</ListDeletedQueryRs>');
    expect(updates()).toHaveLength(0);
  });
});
