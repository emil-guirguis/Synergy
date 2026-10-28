import { describe, it, expect } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { buildDocumentPdf, type DocumentHeader, type DocumentLine } from './documentPdf';

const header: DocumentHeader = {
  kind: 'Order',
  refNumber: '1001',
  customerName: 'Acme Co',
  billTo: 'Acme Co\n123 Main St\nDallas, TX 75201',
  date: '2026-10-06',
  poNumber: 'PO-55',
  jobName: 'Riverside Remodel',
  total: 150,
};

const lines: DocumentLine[] = [
  { item: 'WIDGET-1', description: 'Widget, large', quantity: 2, rate: 50, amount: 100 },
  { item: 'WIDGET-2', description: 'Widget, small', quantity: 5, rate: 10, amount: 50 },
];

describe('buildDocumentPdf', () => {
  it('produces a valid single-page PDF for a normal line count', async () => {
    const bytes = await buildDocumentPdf(header, lines);
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');

    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('produces a valid PDF with no line items', async () => {
    const bytes = await buildDocumentPdf({ ...header, total: 0 }, []);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('paginates when there are enough lines to overflow one page', async () => {
    const manyLines: DocumentLine[] = Array.from({ length: 80 }, (_, i) => ({
      item: `ITEM-${i}`,
      description: `Line ${i}`,
      quantity: 1,
      rate: 10,
      amount: 10,
    }));
    const bytes = await buildDocumentPdf(header, manyLines);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it('falls back to customerName when billTo is null', async () => {
    const bytes = await buildDocumentPdf({ ...header, billTo: null }, lines);
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
  });

  it('renders fine with none of the migration-120 QB template fields set (a pre-backfill invoice)', async () => {
    const bytes = await buildDocumentPdf(
      { kind: 'Invoice', refNumber: '9001', customerName: 'Acme Co', billTo: null, date: '2026-10-01', total: 123.45 },
      [{ item: 'WIDGET', description: 'A widget', quantity: 2, rate: 61.7, amount: 123.4 }]
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString('ascii')).toBe('%PDF-');
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('renders fine with every QB-template field populated (full header + Ship To + company)', async () => {
    const bytes = await buildDocumentPdf(
      {
        ...header,
        kind: 'Invoice',
        shipTo: 'Acme Warehouse\n456 Dock Rd\nDallas, TX 75201',
        dueDate: '2026-11-05',
        shipDate: '2026-10-06',
        termsLabel: 'Terms',
        terms: 'Net 30',
        soNumber: 'TBWC 5742',
        rep: 'MEG',
        fob: 'Origin',
        shipVia: 'UPS Ground',
        subtotal: 150,
        salesTaxPercent: 8.25,
        salesTaxAmount: 12.38,
        balanceDue: 150,
        company: { name: 'TBWC, Inc.', addressLines: ['6130 W. Flamingo Rd, #256', 'Las Vegas, NV 89103'], contactEmail: 'accounting@tbwcinc.com' },
      },
      lines
    );
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('shades a FREIGHT line item row without throwing (case-insensitive)', async () => {
    const bytes = await buildDocumentPdf(header, [...lines, { item: 'freight', description: 'Tracking: 123', quantity: null, rate: 14.46, amount: 14.46 }]);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });
});

describe('money', () => {
  it('adds thousands separators', async () => {
    const { money } = await import('./documentPdf');
    expect(money(2785)).toBe('$2,785.00');
    expect(money(984.46)).toBe('$984.46');
    expect(money(null)).toBe('');
  });
});
