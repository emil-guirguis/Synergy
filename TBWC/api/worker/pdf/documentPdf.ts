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
const LINE_HEIGHT = 11; // one wrapped line of item/description text
const ROW_SIZE = 8; // line-item row font — smaller than the 9pt default so
// Item/Description have room; at 9pt a 20-char item routinely ran past
// Description's own start and the two columns visibly overlapped.

// Item/Description are left-aligned text columns that wrap onto extra lines
// within their row when too long (see wrapText) instead of colliding with
// their neighbor or truncating silently.
const ITEM_X = MARGIN;
const ITEM_WIDTH = 85;
const DESC_X = MARGIN + 95;
const DESC_WIDTH = 230;

// Numeric columns' right edges — numbers right-align to these so they line
// up on a clean right edge instead of a ragged one (the usual invoice/table
// convention); Item/Description above stay left-aligned.
const QTY_RIGHT = MARGIN + 355;
const RATE_RIGHT = MARGIN + 435;
const AMOUNT_RIGHT = PAGE_WIDTH - MARGIN;

export const money = (n: number | null): string => (n == null ? '' : `$${n.toFixed(2)}`);

export async function buildDocumentPdf(header: DocumentHeader, lines: DocumentLine[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  let page: PDFPage;
  let y = 0;

  const text = (s: string, x: number, yy: number, f: PDFFont = font, size = 9) =>
    page.drawText(s, { x, y: yy, size, font: f, color: rgb(0.1, 0.1, 0.1) });

  // Draws so `s` ends flush at `rightX` instead of starting at a fixed x.
  const rightText = (s: string, rightX: number, yy: number, f: PDFFont = font, size = 9) =>
    text(s, rightX - f.widthOfTextAtSize(s, size), yy, f, size);

  // Greedy word-wrap to fit `maxWidth` — Item/Description get a second (or
  // third...) line within their own row instead of truncating or overrunning
  // into the next column. A single word wider than maxWidth is left as-is
  // rather than broken mid-word.
  const wrapText = (s: string, maxWidth: number, f: PDFFont, size: number): string[] => {
    if (!s) return [''];
    const words = s.split(/\s+/).filter(Boolean);
    const out: string[] = [];
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (line && f.widthOfTextAtSize(candidate, size) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) out.push(line);
    return out.length ? out : [''];
  };

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
    rightText('Qty', QTY_RIGHT, y, bold);
    rightText('Rate', RATE_RIGHT, y, bold);
    rightText('Amount', AMOUNT_RIGHT, y, bold);
    y -= 8;
    hLine(y);
    y -= 16;
  };

  page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawHeaderAndTableHead();

  for (const line of lines) {
    const itemLines = wrapText(line.item ?? '', ITEM_WIDTH, font, ROW_SIZE);
    const descLines = wrapText(line.description ?? '', DESC_WIDTH, font, ROW_SIZE);
    const rowHeight = Math.max(itemLines.length, descLines.length, 1) * LINE_HEIGHT;

    if (y - rowHeight < MARGIN + 40) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawHeaderAndTableHead();
    }

    const rowTopY = y;
    itemLines.forEach((s, i) => text(s, ITEM_X, rowTopY - i * LINE_HEIGHT, font, ROW_SIZE));
    descLines.forEach((s, i) => text(s, DESC_X, rowTopY - i * LINE_HEIGHT, font, ROW_SIZE));
    rightText(line.quantity != null ? String(line.quantity) : '', QTY_RIGHT, rowTopY, font, ROW_SIZE);
    rightText(money(line.rate), RATE_RIGHT, rowTopY, font, ROW_SIZE);
    rightText(money(line.amount), AMOUNT_RIGHT, rowTopY, font, ROW_SIZE);
    y -= rowHeight;
  }

  if (y < MARGIN + 30) {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y -= 6;
  hLine(y);
  y -= 20;
  text('Total', PAGE_WIDTH - MARGIN - 140, y, bold, 11);
  rightText(money(header.total), AMOUNT_RIGHT, y, bold, 11);

  return pdf.save();
}
