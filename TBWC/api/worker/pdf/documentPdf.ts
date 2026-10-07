/**
 * Renders an order or invoice to a PDF for emailing to a customer (see
 * aiChat.ts's email_order/email_invoice tools). pdf-lib is pure JS — no
 * fs/native deps — so it runs on the Workers runtime, unlike most PDF
 * libraries which assume Node.
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';

export interface DocumentLine {
  item: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}

export interface DocumentHeader {
  kind: 'Order' | 'Invoice';
  refNumber: string | null;
  customerName: string | null;
  /** Pre-joined address text, lines separated by '\n'. Falls back to customerName. */
  billTo: string | null;
  date: string | null;
  /** Invoice due date / order PO date — whatever the caller wants as the second date line. */
  secondaryDate?: { label: string; value: string | null } | null;
  jobName?: string | null;
  poNumber?: string | null;
  total: number | null;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const ROW_HEIGHT = 18;

export const money = (n: number | null): string => (n == null ? '' : `$${n.toFixed(2)}`);

export async function buildDocumentPdf(header: DocumentHeader, lines: DocumentLine[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage;
  let y = 0;

  const text = (s: string, x: number, yy: number, f: PDFFont = font, size = 9) =>
    page.drawText(s, { x, y: yy, size, font: f, color: rgb(0.1, 0.1, 0.1) });

  const hLine = (yy: number) =>
    page.drawLine({ start: { x: MARGIN, y: yy }, end: { x: PAGE_WIDTH - MARGIN, y: yy }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });

  // Re-drawn on every page so a multi-page order/invoice still reads cleanly
  // on each sheet, not just the first.
  const drawHeaderAndTableHead = () => {
    y = PAGE_HEIGHT - MARGIN;
    text('TBWC Technology', MARGIN, y, bold, 16);
    text(`${header.kind} ${header.refNumber ?? ''}`, PAGE_WIDTH - MARGIN - 160, y, bold, 14);
    y -= 26;

    text('Bill To:', MARGIN, y, bold, 10);
    let billY = y - 14;
    for (const line of (header.billTo || header.customerName || '').split('\n')) {
      text(line, MARGIN, billY);
      billY -= 13;
    }

    const metaX = PAGE_WIDTH - MARGIN - 180;
    let metaY = y - 14;
    text(`Date: ${header.date ?? ''}`, metaX, metaY); metaY -= 14;
    if (header.poNumber) { text(`PO #: ${header.poNumber}`, metaX, metaY); metaY -= 14; }
    if (header.jobName) { text(`Job: ${header.jobName}`, metaX, metaY); metaY -= 14; }
    if (header.secondaryDate?.value) { text(`${header.secondaryDate.label}: ${header.secondaryDate.value}`, metaX, metaY); metaY -= 14; }

    y = Math.min(billY, metaY) - 14;
    text('Item', MARGIN, y, bold);
    text('Description', MARGIN + 90, y, bold);
    text('Qty', MARGIN + 320, y, bold);
    text('Rate', MARGIN + 370, y, bold);
    text('Amount', PAGE_WIDTH - MARGIN - 60, y, bold);
    y -= 8;
    hLine(y);
    y -= 16;
  };

  page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeaderAndTableHead();

  for (const line of lines) {
    if (y < MARGIN + 40) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawHeaderAndTableHead();
    }
    text((line.item ?? '').slice(0, 20), MARGIN, y);
    text((line.description ?? '').slice(0, 45), MARGIN + 90, y);
    text(line.quantity != null ? String(line.quantity) : '', MARGIN + 320, y);
    text(money(line.rate), MARGIN + 370, y);
    text(money(line.amount), PAGE_WIDTH - MARGIN - 60, y);
    y -= ROW_HEIGHT;
  }

  if (y < MARGIN + 30) {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y -= 6;
  hLine(y);
  y -= 20;
  text('Total', PAGE_WIDTH - MARGIN - 140, y, bold, 11);
  text(money(header.total), PAGE_WIDTH - MARGIN - 60, y, bold, 11);

  return pdf.save();
}
