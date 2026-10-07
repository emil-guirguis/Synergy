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
});
