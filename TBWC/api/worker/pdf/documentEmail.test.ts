import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendMail = vi.fn();
vi.mock('../mail', () => ({ sendMail: (...a: any[]) => mockSendMail(...a) }));

import { sendDocumentEmail, formatMDY, formatInvoiceBillTo, invoiceDocumentHeader } from './documentEmail';
import type { DocumentHeader, DocumentLine } from './documentPdf';

const ENV = {} as any;
const LINES: DocumentLine[] = [{ item: 'WIDGET', description: 'A widget', quantity: 1, rate: 100, amount: 100 }];
const BASE_HEADER: DocumentHeader = {
  kind: 'Invoice',
  refNumber: '10522',
  customerName: 'Acme Co',
  billTo: 'Acme Co',
  date: '2026-08-01',
  total: 2785,
};

function lastCall() {
  return mockSendMail.mock.calls[mockSendMail.mock.calls.length - 1][1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSendMail.mockResolvedValue(undefined);
});

describe('sendDocumentEmail subject', () => {
  it('defaults to "{kind} {ref} from TBWC, Inc."', async () => {
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com');
    expect(lastCall().subject).toBe('Invoice 10522 from TBWC, Inc.');
  });

  it('appends "[PO Number: X]" when the header carries one', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, poNumber: '123456' }, LINES, 'c@x.com');
    expect(lastCall().subject).toBe('Invoice 10522 from TBWC, Inc. [PO Number: 123456]');
  });

  it('appends the PO suffix on top of a caller-supplied subject override too', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, poNumber: '123456' }, LINES, 'c@x.com', { subject: 'Late Invoice 10522' });
    expect(lastCall().subject).toBe('Late Invoice 10522 [PO Number: 123456]');
  });

  it('omits the PO suffix entirely when there is no PO number', async () => {
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com', { subject: 'Late Invoice 10522' });
    expect(lastCall().subject).toBe('Late Invoice 10522');
  });
});

describe('sendDocumentEmail bodyHtml (the branded card)', () => {
  it('shows Amount Due from balanceDue, not total, when both are given', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, total: 2785, balanceDue: 1000 }, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('Amount Due: </span><span style="font-size:24px;font-family:Helvetica,Arial,sans-serif;color:#3E3E3E;">$1,000.00');
  });

  it('falls back to total for Amount Due when balanceDue is absent (orders)', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, kind: 'Order', total: 2785 }, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('$2,785.00');
  });

  it('omits the Amount Due cell entirely when neither figure is known', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, total: null }, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).not.toContain('Amount Due');
  });

  it('shows a Due: line only when dueDate is set', async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, dueDate: '2026-08-31' }, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('>Due: 2026-08-31<');

    // #E77B07 (the "Due:" line's own color) is a safer negative check than the
    // bare word "Due" — "Amount Due: " legitimately appears either way.
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).not.toContain('#E77B07');
  });

  it('uses the caller-supplied message verbatim (escaped, newlines to <br>) over the generic default', async () => {
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com', { message: 'Dear Customer,\n\nThanks <3' });
    const html = lastCall().bodyHtml;
    expect(html).toContain('Dear Customer,<br><br>Thanks &lt;3');
    expect(html).not.toContain('Please find your invoice');
  });

  it('falls back to the generic "Please find your {kind} attached" message when none is given', async () => {
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('Please find your invoice 10522 attached');
  });

  it('includes the hosted TBWC logo under the message/signature', async () => {
    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('<img src="https://tbwctechnology.com/favicon.png"');
  });

  it("uses the company's own name when given, TBWC, Inc. otherwise", async () => {
    await sendDocumentEmail(ENV, { ...BASE_HEADER, company: { name: 'Acme Holdings', addressLines: [], contactEmail: null } }, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('Acme Holdings');

    await sendDocumentEmail(ENV, BASE_HEADER, LINES, 'c@x.com');
    expect(lastCall().bodyHtml).toContain('TBWC, Inc.');
  });
});

describe('formatMDY', () => {
  it('reformats an ISO date (string or Date) to MM/DD/YYYY', () => {
    expect(formatMDY('2026-08-01')).toBe('08/01/2026');
    expect(formatMDY('2026-08-31T00:00:00.000Z')).toBe('08/31/2026');
    expect(formatMDY(new Date(Date.UTC(2026, 7, 1)))).toBe('08/01/2026');
  });

  it('passes through null/unparseable input unchanged', () => {
    expect(formatMDY(null)).toBeNull();
    expect(formatMDY(undefined)).toBeNull();
  });
});

describe('formatInvoiceBillTo', () => {
  it('drops an address line 1 that just repeats the customer name', () => {
    // Live case: a test/dummy QB customer had its own name typed into
    // Address Line 1 too ("TEST COMPANY" / "TEST COMPANY").
    expect(formatInvoiceBillTo('TEST COMPANY', { addr1: 'TEST COMPANY', addr2: null, city: null, state: null, postal: null }))
      .toBe('TEST COMPANY');
  });

  it('keeps a genuinely different address line 1', () => {
    expect(formatInvoiceBillTo('Acme Co', { addr1: '123 Main St', addr2: null, city: 'Dallas', state: 'TX', postal: '75201' }))
      .toBe('Acme Co\n123 Main St\nDallas, TX 75201');
  });
});

describe('invoiceDocumentHeader', () => {
  it('formats date fields as MM/DD/YYYY, not ISO', () => {
    const header = invoiceDocumentHeader({
      ref_number: '10522', customer_name: 'Acme', txn_date: '2026-08-01', due_date: '2026-08-31',
      ship_date: '2026-10-27', total: 100, bill_addr: null,
    });
    expect(header.date).toBe('08/01/2026');
    expect(header.dueDate).toBe('08/31/2026');
    expect(header.shipDate).toBe('10/27/2026');
  });
});
