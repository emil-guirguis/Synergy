import { describe, it, expect } from 'vitest';
import {
  QBXML_VERSION, qbxmlDoc, tag, blocks, statusCode, escapeXml, unescapeXml,
  qbTimeToTs, qbDate, num, refField, lineItems, toQbLocal,
  pendingIterator, iteratorContinueDoc, QB_MAX_RETURNED,
} from './qbxml';

describe('qbxml.toQbLocal', () => {
  it('renders a UTC instant as Pacific wall-clock with offset (DST)', () => {
    // 2026-09-01T19:52:00Z = 12:52 PDT (UTC-7).
    expect(toQbLocal('2026-09-01T19:52:00.000Z')).toBe('2026-09-01T12:52:00-07:00');
  });

  it('uses the standard-time offset in winter', () => {
    // 2026-01-15T20:00:00Z = 12:00 PST (UTC-8).
    expect(toQbLocal('2026-01-15T20:00:00.000Z')).toBe('2026-01-15T12:00:00-08:00');
  });

  it('accepts a Date and an explicit zone', () => {
    expect(toQbLocal(new Date('2026-09-01T19:52:00Z'), 'America/New_York'))
      .toBe('2026-09-01T15:52:00-04:00');
  });
});

describe('qbxml.qbxmlDoc', () => {
  it('wraps inner fragment with the qbxml PI and default continueOnError', () => {
    const doc = qbxmlDoc('<CustomerQueryRq/>');
    expect(doc).toContain(`<?qbxml version="${QBXML_VERSION}"?>`);
    expect(doc).toContain('<QBXMLMsgsRq onError="continueOnError">');
    expect(doc).toContain('<CustomerQueryRq/>');
  });

  it('honors an explicit onError mode', () => {
    expect(qbxmlDoc('<X/>', 'stopOnError')).toContain('onError="stopOnError"');
  });
});

describe('qbxml.tag', () => {
  it('returns first tag text, unescaped', () => {
    expect(tag('<FullName>A &amp; B</FullName>', 'FullName')).toBe('A & B');
  });
  it('returns undefined when missing', () => {
    expect(tag('<Other>x</Other>', 'FullName')).toBeUndefined();
  });
});

describe('qbxml.blocks', () => {
  it('returns every top-level block of a repeated element', () => {
    const xml = '<CustomerRet><ListID>1</ListID></CustomerRet><CustomerRet><ListID>2</ListID></CustomerRet>';
    const b = blocks(xml, 'CustomerRet');
    expect(b).toHaveLength(2);
    expect(tag(b[0], 'ListID')).toBe('1');
    expect(tag(b[1], 'ListID')).toBe('2');
  });
  it('returns empty array when none present', () => {
    expect(blocks('<Empty/>', 'CustomerRet')).toEqual([]);
  });
});

describe('qbxml.statusCode', () => {
  it('reads the statusCode attribute off a *Rs element', () => {
    expect(statusCode('<CustomerQueryRs requestID="customer" statusCode="0">', 'CustomerQueryRs')).toBe('0');
  });
  it('reads a non-zero status', () => {
    expect(statusCode('<CustomerQueryRs statusCode="1" statusMessage="none">', 'CustomerQueryRs')).toBe('1');
  });
  it('returns undefined when attribute absent', () => {
    expect(statusCode('<CustomerQueryRs>', 'CustomerQueryRs')).toBeUndefined();
  });
});

describe('qbxml escape/unescape', () => {
  it('escapes all five metacharacters', () => {
    expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;');
  });
  it('round-trips', () => {
    const raw = `Tom & Jerry's <"Co">`;
    expect(unescapeXml(escapeXml(raw))).toBe(raw);
  });
});

describe('qbxml.qbTimeToTs', () => {
  // QB's own offset is ignored — the SVR2012 machine doesn't auto-adjust for
  // DST and always stamps "-08:00", even in months America/Los_Angeles is
  // really at -07:00 (PDT). The wall-clock digits are trusted instead and
  // converted using the zone's real DST rule for that date.
  it('uses the real zone offset outside DST (winter, PST -08:00)', () => {
    expect(qbTimeToTs('2026-01-15T10:30:00-08:00')).toBe('2026-01-15T18:30:00.000Z');
  });
  it('uses the real zone offset during DST (summer, PDT -07:00), ignoring QB\'s mislabeled -08:00', () => {
    expect(qbTimeToTs('2026-09-08T18:25:15-08:00')).toBe('2026-09-09T01:25:15.000Z');
  });
  it('returns null for undefined', () => {
    expect(qbTimeToTs(undefined)).toBeNull();
  });
  it('returns null for an unparseable value', () => {
    expect(qbTimeToTs('not-a-date')).toBeNull();
  });
});

describe('qbxml.qbDate', () => {
  it('passes through a valid YYYY-MM-DD', () => {
    expect(qbDate('2024-03-01')).toBe('2024-03-01');
  });
  it('rejects non ISO dates', () => {
    expect(qbDate('03/01/2024')).toBeNull();
    expect(qbDate(undefined)).toBeNull();
  });
});

describe('qbxml.num', () => {
  it('parses numeric strings', () => {
    expect(num('12.5')).toBe(12.5);
    expect(num('0')).toBe(0);
  });
  it('returns null for empty/undefined', () => {
    expect(num('')).toBeNull();
    expect(num(undefined)).toBeNull();
  });
});

describe('qbxml.refField', () => {
  it('reads ListID and FullName from a *Ref block', () => {
    const scope = '<CustomerRef><ListID>80000001</ListID><FullName>Acme</FullName></CustomerRef>';
    expect(refField(scope, 'CustomerRef')).toEqual({ listId: '80000001', fullName: 'Acme' });
  });
  it('returns empty object when the ref block is absent', () => {
    expect(refField('<X/>', 'CustomerRef')).toEqual({});
  });
});

describe('qbxml.lineItems', () => {
  it('maps line rows, preferring FullName then ListID for item', () => {
    const scope =
      '<InvoiceLineRet><ItemRef><ListID>5</ListID><FullName>Widget</FullName></ItemRef>' +
      '<Desc>A widget</Desc><Quantity>2</Quantity><Rate>9.99</Rate><Amount>19.98</Amount></InvoiceLineRet>' +
      '<InvoiceLineRet><ItemRef><ListID>6</ListID></ItemRef><Amount>5</Amount></InvoiceLineRet>';
    const lines = lineItems(scope, 'InvoiceLineRet');
    expect(lines).toEqual([
      { item: 'Widget', desc: 'A widget', quantity: 2, rate: 9.99, amount: 19.98 },
      { item: '6', desc: null, quantity: null, rate: null, amount: 5 },
    ]);
  });
  it('returns empty array with no line elements', () => {
    expect(lineItems('<InvoiceRet/>', 'InvoiceLineRet')).toEqual([]);
  });
});

describe('qbxml.pendingIterator', () => {
  const wrap = (rs: string) =>
    `<?xml version="1.0"?><QBXML><QBXMLMsgsRs>${rs}</QBXMLMsgsRs></QBXML>`;

  it('finds the iterated Rs inside the QBXMLMsgsRs wrapper', () => {
    const xml = wrap(
      '<SalesOrderQueryRs requestID="salesorder" statusCode="0" statusSeverity="Info" ' +
      'iteratorRemainingCount="4066" iteratorID="{abc-123}"><SalesOrderRet/></SalesOrderQueryRs>'
    );
    expect(pendingIterator(xml)).toEqual({
      rqName: 'SalesOrderQueryRq', requestID: 'salesorder', iteratorId: '{abc-123}',
    });
  });

  it('returns undefined when nothing remains', () => {
    const xml = wrap(
      '<CustomerQueryRs requestID="customer" statusCode="0" ' +
      'iteratorRemainingCount="0" iteratorID="{abc}"><CustomerRet/></CustomerQueryRs>'
    );
    expect(pendingIterator(xml)).toBeUndefined();
  });

  it('returns undefined for a non-iterated response', () => {
    const xml = wrap('<CustomerQueryRs requestID="customer" statusCode="1"/>');
    expect(pendingIterator(xml)).toBeUndefined();
  });

  it('tolerates attribute order variations', () => {
    const xml = wrap(
      '<CustomerQueryRs iteratorID="{z}" iteratorRemainingCount="12" requestID="customer" statusCode="0"/>'
    );
    expect(pendingIterator(xml)).toEqual({
      rqName: 'CustomerQueryRq', requestID: 'customer', iteratorId: '{z}',
    });
  });
});

describe('qbxml.iteratorContinueDoc', () => {
  it('emits a Continue request with MaxReturned and extras', () => {
    const doc = iteratorContinueDoc(
      'SalesOrderQueryRq', 'salesorder', '{abc}', '      <IncludeLineItems>true</IncludeLineItems>\n'
    );
    expect(doc).toContain('iterator="Continue"');
    expect(doc).toContain('iteratorID="{abc}"');
    expect(doc).toContain(`<MaxReturned>${QB_MAX_RETURNED}</MaxReturned>`);
    expect(doc).toContain('<IncludeLineItems>true</IncludeLineItems>');
    expect(doc.indexOf('<MaxReturned>')).toBeLessThan(doc.indexOf('<IncludeLineItems>'));
  });
});
