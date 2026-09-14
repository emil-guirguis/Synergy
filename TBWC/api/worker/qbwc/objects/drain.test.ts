/**
 * Drain detection for incremental pulls. markDrainComplete is the only thing
 * that ever clears a queued full reload, so an object whose drained response
 * isn't recognised here re-pulls its whole table on every session forever.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db', () => ({ execQuery: vi.fn(async () => ({ rows: [], rowCount: 0 })) }));

import { registry, drainedQueryOwner } from './index';

const rs = (name: string, attrs: string) =>
  `<?xml version="1.0"?><QBXML><QBXMLMsgsRs><${name}QueryRs ${attrs}></${name}QueryRs></QBXMLMsgsRs></QBXML>`;

describe('drainedQueryOwner', () => {
  const incremental = registry.filter((o) => o.incremental);

  it('recognises a drained query for every incremental object, not just Invoice', () => {
    for (const obj of incremental) {
      const base = obj.requestID === 'salesorder' ? 'SalesOrder'
        : obj.requestID === 'salesrep' ? 'SalesRep'
        : obj.name;
      const owner = drainedQueryOwner(rs(base, `requestID="${obj.requestID}" statusCode="0"`));
      expect(owner?.name, `${obj.name} response went unrecognised`).toBe(obj.name);
    }
    expect(incremental.length).toBeGreaterThan(1);
  });

  it('treats statusCode 1 (no matching records) as drained', () => {
    expect(drainedQueryOwner(rs('Customer', 'requestID="customer" statusCode="1"'))?.name).toBe('Customer');
  });

  it('does not mark an errored query drained', () => {
    // QB Pro rejects SalesOrderQueryRq outright; clearing a queued reload on
    // that would drop the reload without ever re-pulling.
    expect(drainedQueryOwner(rs('SalesOrder', 'requestID="salesorder" statusCode="3140"'))).toBeUndefined();
  });

  it('ignores Add/Mod push responses, which echo requestID with a local-id suffix', () => {
    const push = '<SalesOrderModRs requestID="salesorder:mod:ABC-1" statusCode="0"></SalesOrderModRs>';
    expect(drainedQueryOwner(push)).toBeUndefined();
  });

  it('ignores the non-incremental deletion sweeps', () => {
    const del = rs('TxnDeleted', 'requestID="txndeleted:SalesOrder" statusCode="0"');
    expect(drainedQueryOwner(del)).toBeUndefined();
  });
});
