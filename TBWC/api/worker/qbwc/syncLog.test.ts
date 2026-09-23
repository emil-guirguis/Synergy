import { describe, it, expect } from 'vitest';
import { parseRsBlocks } from './syncLog';

describe('parseRsBlocks', () => {
  it('counts Ret records in a pull response', () => {
    const xml =
      `<QBXML><QBXMLMsgsRs>` +
      `<CustomerQueryRs requestID="customer" statusCode="0" statusSeverity="Info" statusMessage="Status OK">` +
      `<CustomerRet><ListID>1</ListID></CustomerRet>` +
      `<CustomerRet><ListID>2</ListID></CustomerRet>` +
      `</CustomerQueryRs></QBXMLMsgsRs></QBXML>`;
    const rows = parseRsBlocks(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      objectType: 'Customer', direction: 'pull', statusCode: '0', rowsProcessed: 2, error: null,
    });
  });

  it('does not count nested line Rets (InvoiceLineRet inside InvoiceRet)', () => {
    const xml =
      `<InvoiceQueryRs requestID="invoice" statusCode="0">` +
      `<InvoiceRet><TxnID>A</TxnID><InvoiceLineRet><Amount>1</Amount></InvoiceLineRet>` +
      `<InvoiceLineRet><Amount>2</Amount></InvoiceLineRet></InvoiceRet>` +
      `</InvoiceQueryRs>`;
    const rows = parseRsBlocks(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0].rowsProcessed).toBe(1);
  });

  it('handles self-closing empty result and treats statusCode 1 as non-error', () => {
    const xml = `<CustomerQueryRs requestID="customer" statusCode="1" statusMessage="No match" />`;
    const rows = parseRsBlocks(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rowsProcessed: 0, statusCode: '1', error: null });
  });

  it('classifies Add responses as push and flags real errors', () => {
    const xml =
      `<VendorQueryRs requestID="vendor" statusCode="0"><VendorRet><ListID>V1</ListID></VendorRet></VendorQueryRs>` +
      `<VendorAddRs requestID="vendor:add:42" statusCode="3100" statusMessage="Name already in use" />`;
    const rows = parseRsBlocks(xml);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ objectType: 'Vendor', direction: 'pull', rowsProcessed: 1 });
    expect(rows[1]).toMatchObject({
      objectType: 'Vendor', direction: 'push', statusCode: '3100', error: 'Name already in use',
    });
  });

  it('ignores non-object elements', () => {
    expect(parseRsBlocks('<QBXMLMsgsRs onError="stopOnError"></QBXMLMsgsRs>')).toHaveLength(0);
  });

  it('aliases ReceivePaymentQueryRs to the Payment object type', () => {
    const xml =
      `<ReceivePaymentQueryRs requestID="payment" statusCode="0">` +
      `<ReceivePaymentRet><TxnID>P1</TxnID></ReceivePaymentRet>` +
      `</ReceivePaymentQueryRs>`;
    const rows = parseRsBlocks(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ objectType: 'Payment', direction: 'pull', rowsProcessed: 1 });
  });
});
