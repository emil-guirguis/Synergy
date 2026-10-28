/**
 * Renders an order or invoice to a PDF for emailing to a customer (see
 * aiChat.ts's email_order/email_invoice tools, orders.ts's POST /:id/email,
 * and invoices.ts's sendInvoiceNoticeEmail). pdf-lib is pure JS — no fs/
 * native deps — so it runs on the Workers runtime, unlike most PDF libraries
 * which assume Node.
 *
 * Laid out to match the "TBWC Invoice" QuickBooks Desktop template (verified
 * against real QB-generated PDFs, invoices #10459 and #10522, 2026-10): logo
 * + Remit To at top-left, a Ship/Invoice/Due Date + Terms + ref# grid at
 * top-right, a Bill To / Ship To box pair, a one-row box for S.O./P.O./Job
 * Name/Rep/FOB/Ship Via/Freight Acct-ZIP, a bordered line-item table that
 * fills the page regardless of row count (FREIGHT rows shaded, same as QB's
 * own render), and a boxed Subtotal/Sales Tax/Total panel. Order and
 * Invoice share every bit of this — they differ only in which optional
 * DocumentHeader fields their caller was able to populate (see
 * documentEmail.ts's invoiceDocumentHeader/orderDocumentHeader).
 *
 * Every box QB's template has is always drawn here too, blank rather than
 * omitted when this app has no data for it (FOB/Freight Acct-ZIP always;
 * Terms/Ship To/etc. on an invoice not yet re-pulled since migration 120) —
 * the PDF's shape must match regardless of which fields a given record
 * happens to have filled in. The one structural (not data-driven) exception
 * is S.O. No., which only an Invoice shows — an Order has no parent order to
 * reference, so QB's own order template doesn't carry that box either.
 */
import { PDFDocument, PDFFont, PDFImage, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { TBWC_LOGO_PNG_BASE64 } from './tbwcLogo.generated';

export interface DocumentLine {
  item: string | null;
  description: string | null;
  quantity: number | null;
  rate: number | null;
  amount: number | null;
}

/** public.company_settings, as loadCompanySettings (documentEmail.ts) reads it. */
export interface CompanyInfo {
  name: string | null;
  /** Pre-split, blank-filtered: [street, street2, "city, state zip"]. */
  addressLines: string[];
  contactEmail: string | null;
}

export interface DocumentHeader {
  kind: 'Order' | 'Invoice';
  refNumber: string | null;
  customerName: string | null;
  /** Pre-joined address text, lines separated by '\n'. Falls back to customerName. */
  billTo: string | null;
  /** Pre-joined address text. No box is drawn when null (most orders/invoices
   *  ship to the billing address and QB simply doesn't carry a separate one). */
  shipTo?: string | null;
  /** Invoice Date / Order (txn) Date. */
  date: string | null;
  dueDate?: string | null;
  shipDate?: string | null;
  /** Box label for `terms` — "Terms" on an invoice, "Freight Terms" on an
   *  order (this company's order-side Terms list holds freight codes, not
   *  payment terms — see documentEmail.ts's OrderDocumentRow). */
  termsLabel?: string;
  terms?: string | null;
  /** Invoice only — the sales order it was created from. */
  soNumber?: string | null;
  poNumber?: string | null;
  jobName?: string | null;
  rep?: string | null;
  /** Not present anywhere in TBWC's QB data today (see module comment) —
   *  always blank in practice, kept so a future sync addition needs no PDF change. */
  fob?: string | null;
  shipVia?: string | null;
  /** Invoice only (migration 121) — QB's generic header <Other> text field.
   *  Always blank on an order; no SalesOrder equivalent has been wired. */
  freightAcctZip?: string | null;
  subtotal?: number | null;
  salesTaxPercent?: number | null;
  salesTaxAmount?: number | null;
  total: number | null;
  /** Invoice only — balance_remaining. The email banner's "Amount Due"
   *  prefers this over `total` (a partially-paid invoice is only "due" for
   *  what's left, same distinction invoices.ts's DAYS_PAST_DUE draws). */
  balanceDue?: number | null;
  company?: CompanyInfo | null;
}

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 40;
const LINE_HEIGHT = 11; // one wrapped line of item/description text
const ROW_SIZE = 8; // line-item row font

const TABLE_LEFT = MARGIN;
const TABLE_RIGHT = PAGE_WIDTH - MARGIN;

// Item/Description are left-aligned text columns that wrap onto extra lines
// within their row when too long (see wrapText) instead of colliding with
// their neighbor or truncating silently.
const ITEM_X = TABLE_LEFT + 4;
const DESC_X = TABLE_LEFT + 118;
const QTY_X = TABLE_LEFT + 352;
const RATE_X = TABLE_LEFT + 402;
const AMOUNT_X = TABLE_LEFT + 462;
const COL_LINES = [TABLE_LEFT, TABLE_LEFT + 114, QTY_X - 4, RATE_X - 4, AMOUNT_X - 4, TABLE_RIGHT];
const ITEM_WIDTH = DESC_X - ITEM_X - 6;
const DESC_WIDTH = QTY_X - DESC_X - 10;
const QTY_RIGHT = RATE_X - 4;
const RATE_RIGHT = AMOUNT_X - 4;
const AMOUNT_RIGHT = TABLE_RIGHT - 4;

export const money = (n: number | null): string =>
  n == null ? '' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** FREIGHT lines get a shaded row, same as QB's own template render (and the
 *  same ILIKE 'FREIGHT' convention migrations 049-053 already use to spot a
 *  freight line item elsewhere in this app). */
const isFreightLine = (item: string | null): boolean => !!item && /^freight$/i.test(item.trim());

let cachedLogoBytes: Uint8Array | null = null;
function logoBytes(): Uint8Array {
  if (!cachedLogoBytes) {
    const binary = atob(TBWC_LOGO_PNG_BASE64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    cachedLogoBytes = bytes;
  }
  return cachedLogoBytes;
}

export async function buildDocumentPdf(header: DocumentHeader, lines: DocumentLine[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(logoBytes());

  let page: PDFPage;
  let y = 0;

  const text = (s: string, x: number, yy: number, f: PDFFont = font, size = 9, color = rgb(0.1, 0.1, 0.1)) =>
    page.drawText(s, { x, y: yy, size, font: f, color });

  // Draws so `s` ends flush at `rightX` instead of starting at a fixed x.
  const rightText = (s: string, rightX: number, yy: number, f: PDFFont = font, size = 9) =>
    text(s, rightX - f.widthOfTextAtSize(s, size), yy, f, size);

  const hLine = (x1: number, x2: number, yy: number, color = rgb(0.55, 0.55, 0.55), thickness = 0.75) =>
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness, color });

  const vLine = (x: number, y1: number, y2: number, color = rgb(0.55, 0.55, 0.55), thickness = 0.75) =>
    page.drawLine({ start: { x, y: y1 }, end: { x, y: y2 }, thickness, color });

  const fillRect = (x: number, yy: number, w: number, h: number, color = rgb(0.93, 0.93, 0.93)) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, color });

  const strokeRect = (x: number, yy: number, w: number, h: number, color = rgb(0.55, 0.55, 0.55)) =>
    page.drawRectangle({ x, y: yy, width: w, height: h, borderColor: color, borderWidth: 0.75 });

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

  /**
   * A single-row bordered box split into evenly-wide cells, each a small
   * bold label over its value — the S.O./P.O./Job/Rep/FOB/Ship Via/Freight
   * Acct-ZIP row is this shape. (The Ship/Invoice/Due Date + Terms + ref#
   * block above the item table is NOT this shape — see drawHeaderDateGrid,
   * QB's own template offsets Terms/ref# down by one row from the dates.)
   */
  const drawLabeledRow = (
    cells: { label: string; value: string }[],
    x: number,
    topY: number,
    width: number,
    minHeight = 28
  ): number => {
    const colWidth = width / cells.length;
    const wrapped = cells.map((cell) => wrapText(cell.value, colWidth - 8, font, 8));
    const maxLines = Math.max(...wrapped.map((w) => w.length), 1);
    const rowHeight = Math.max(minHeight, 20 + maxLines * 10);
    strokeRect(x, topY - rowHeight, width, rowHeight);
    cells.forEach((cell, i) => {
      const cx = x + i * colWidth;
      if (i > 0) vLine(cx, topY, topY - rowHeight);
      text(cell.label, cx + 4, topY - 10, bold, 7, rgb(0.3, 0.3, 0.3));
      wrapped[i].forEach((ln, li) => text(ln, cx + 4, topY - 21 - li * 10, font, 8.5));
    });
    return topY - rowHeight;
  };

  /**
   * The Ship/Invoice/Due Date + Terms + ref# block under the "Invoice"/
   * "Order" title — QB's own template (confirmed against two real
   * QB-generated invoice PDFs, #10459 and #10522) draws this as two
   * adjacently-bordered boxes of different shapes, not one uniform grid:
   * a 3-row box (label | value per row) for Ship/Invoice/Due Date, beside a
   * shorter 2-row box (label row, then value row, two columns) for Terms
   * and the ref# — offset down by one row so it aligns with the date box's
   * 2nd/3rd rows rather than its 1st, which is where the title sits instead.
   */
  const drawHeaderDateGrid = (
    dateRows: { label: string; value: string }[],
    termsCells: { label: string; value: string }[],
    x: number,
    topY: number,
    width: number
  ): number => {
    const rowH = 20;
    const dateW = width * 0.55;
    const dateColDivide = dateW * 0.42;
    strokeRect(x, topY - rowH * dateRows.length, dateW, rowH * dateRows.length);
    dateRows.forEach((r, i) => {
      const rowTop = topY - i * rowH;
      if (i > 0) hLine(x, x + dateW, rowTop);
      text(r.label, x + 4, rowTop - 14, bold, 7, rgb(0.3, 0.3, 0.3));
      text(r.value, x + dateColDivide + 4, rowTop - 14, font, 8.5);
    });
    vLine(x + dateColDivide, topY, topY - rowH * dateRows.length);

    const termsX = x + dateW;
    const termsW = width - dateW;
    const termsTop = topY - rowH; // offset down one row, same bottom as the date box
    const termsColW = termsW / termsCells.length;
    strokeRect(termsX, termsTop - rowH * 2, termsW, rowH * 2);
    hLine(termsX, termsX + termsW, termsTop - rowH);
    termsCells.forEach((c, i) => {
      const cx = termsX + i * termsColW;
      if (i > 0) vLine(cx, termsTop, termsTop - rowH * 2);
      text(c.label, cx + 4, termsTop - 14, bold, 7, rgb(0.3, 0.3, 0.3));
      text(c.value, cx + 4, termsTop - rowH - 14, font, 8.5);
    });

    return topY - rowH * dateRows.length;
  };

  /** Bordered box with a bold title bar and left-aligned wrapped address text. */
  const drawAddressBox = (title: string, body: string, x: number, topY: number, width: number, height: number) => {
    strokeRect(x, topY - height, width, height);
    hLine(x, x + width, topY - 14);
    text(title, x + 6, topY - 11, bold, 8);
    let by = topY - 27;
    for (const ln of body.split('\n')) {
      for (const wrapped of wrapText(ln, width - 12, font, 8.5)) {
        text(wrapped, x + 6, by, font, 8.5);
        by -= 11;
      }
    }
  };

  // Re-drawn on every page after the first: a short "continued" strip plus
  // the item table's own column header, so a multi-page document still
  // reads cleanly on each sheet without repeating the full letterhead.
  const drawContinuationHeader = () => {
    y = PAGE_HEIGHT - MARGIN;
    text(`${header.kind} ${header.refNumber ?? ''} (continued)`, MARGIN, y, bold, 10);
    y -= 20;
    y = drawItemTableHead(y);
  };

  const drawItemTableHead = (topY: number): number => {
    const headerHeight = 16;
    fillRect(TABLE_LEFT, topY - headerHeight, TABLE_RIGHT - TABLE_LEFT, headerHeight, rgb(0.88, 0.88, 0.88));
    text('Item', ITEM_X, topY - 11, bold, 8.5);
    text('Description', DESC_X, topY - 11, bold, 8.5);
    rightText('Quantity', QTY_RIGHT, topY - 11, bold, 8.5);
    rightText('Rate', RATE_RIGHT, topY - 11, bold, 8.5);
    rightText('Amount', AMOUNT_RIGHT, topY - 11, bold, 8.5);
    for (const cx of COL_LINES) vLine(cx, topY, topY - headerHeight);
    hLine(TABLE_LEFT, TABLE_RIGHT, topY - headerHeight);
    return topY - headerHeight;
  };

  // The full letterhead: logo + Remit To, the date/terms/ref# grid, the big
  // kind title, Bill To / Ship To, the S.O./P.O./Job/Rep/FOB/Ship Via row,
  // then the item table's own header. First page only (see
  // drawContinuationHeader for every page after).
  const drawFirstPageHeader = () => {
    y = PAGE_HEIGHT - MARGIN;

    // Logo + Remit To, top-left.
    const logoWidth = 85;
    const logoHeight = (logo.height / logo.width) * logoWidth;
    page.drawImage(logo, { x: MARGIN, y: y - logoHeight, width: logoWidth, height: logoHeight });
    const remitX = MARGIN + logoWidth + 14;
    let remitY = y - 9;
    text('Remit to:', remitX, remitY, font, 7.5, rgb(0.4, 0.4, 0.4));
    remitY -= 11;
    const companyName = header.company?.name?.trim() || 'TBWC, Inc.';
    text(companyName, remitX, remitY, bold, 9.5);
    remitY -= 12;
    for (const line of header.company?.addressLines ?? []) {
      text(line, remitX, remitY, font, 8.5);
      remitY -= 10.5;
    }
    const remitBottom = Math.min(remitY, y - logoHeight);

    // Big title + the date/terms/ref# grid, top-right. Every box QB's own
    // template prints, always drawn — blank when there's no value rather
    // than omitted, so the layout is identical whether or not this
    // particular record has every field filled in (see module comment).
    const gridWidth = 300;
    const gridX = TABLE_RIGHT - gridWidth;
    text(header.kind, TABLE_RIGHT - bold.widthOfTextAtSize(header.kind, 22), y - 2, bold, 22);
    const refLabel = header.kind === 'Invoice' ? 'Invoice #' : 'Order #';
    const dateRows = [
      { label: 'Ship Date', value: header.shipDate ?? '' },
      { label: `${header.kind} Date`, value: header.date ?? '' },
      { label: 'Due Date', value: header.dueDate ?? '' },
    ];
    const termsCells = [
      { label: header.termsLabel || 'Terms', value: header.terms ?? '' },
      { label: refLabel, value: header.refNumber ?? '' },
    ];
    const gridBottom = drawHeaderDateGrid(dateRows, termsCells, gridX, y - 30, gridWidth);

    y = Math.min(remitBottom, gridBottom) - 14;

    // Bill To / Ship To — both boxes always, Ship To blank rather than
    // dropped when the record has no ship-to address of its own.
    const addrHeight = 70;
    const halfWidth = (TABLE_RIGHT - TABLE_LEFT - 12) / 2;
    drawAddressBox('Bill To', header.billTo || header.customerName || '', TABLE_LEFT, y, halfWidth, addrHeight);
    drawAddressBox('Ship To', header.shipTo || '', TABLE_LEFT + halfWidth + 12, y, halfWidth, addrHeight);
    y -= addrHeight + 14;

    // S.O. No. (invoice only — an order has no parent order to reference) /
    // P.O. No. / Job Name / Rep / FOB / Ship Via / Freight Acct / ZIP —
    // every column always drawn, blank where there's no value.
    const miscCells: { label: string; value: string }[] = [];
    if (header.kind === 'Invoice') miscCells.push({ label: 'S.O. No.', value: header.soNumber ?? '' });
    miscCells.push(
      { label: 'P.O. No.', value: header.poNumber ?? '' },
      { label: 'Job Name', value: header.jobName ?? '' },
      { label: 'Rep', value: header.rep ?? '' },
      { label: 'FOB', value: header.fob ?? '' },
      { label: 'Ship Via', value: header.shipVia ?? '' },
      { label: 'Freight Acct / ZIP', value: header.freightAcctZip ?? '' }
    );
    y = drawLabeledRow(miscCells, TABLE_LEFT, y, TABLE_RIGHT - TABLE_LEFT, 26);
    y -= 14;

    y = drawItemTableHead(y);
  };

  page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawFirstPageHeader();

  for (const line of lines) {
    const itemLines = wrapText(line.item ?? '', ITEM_WIDTH, font, ROW_SIZE);
    const descLines = wrapText(line.description ?? '', DESC_WIDTH, font, ROW_SIZE);
    const rowHeight = Math.max(itemLines.length, descLines.length, 1) * LINE_HEIGHT + 4;

    if (y - rowHeight < MARGIN + 150) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      drawContinuationHeader();
    }

    const rowTopY = y;
    if (isFreightLine(line.item)) fillRect(TABLE_LEFT, rowTopY - rowHeight, TABLE_RIGHT - TABLE_LEFT, rowHeight, rgb(0.93, 0.93, 0.93));
    itemLines.forEach((s, i) => text(s, ITEM_X, rowTopY - 10 - i * LINE_HEIGHT, font, ROW_SIZE));
    descLines.forEach((s, i) => text(s, DESC_X, rowTopY - 10 - i * LINE_HEIGHT, font, ROW_SIZE));
    rightText(line.quantity != null ? String(line.quantity) : '', QTY_RIGHT, rowTopY - 10, font, ROW_SIZE);
    rightText(money(line.rate), RATE_RIGHT, rowTopY - 10, font, ROW_SIZE);
    rightText(money(line.amount), AMOUNT_RIGHT, rowTopY - 10, font, ROW_SIZE);
    for (const cx of COL_LINES) vLine(cx, rowTopY, rowTopY - rowHeight);
    hLine(TABLE_LEFT, TABLE_RIGHT, rowTopY - rowHeight);
    y -= rowHeight;
  }

  // Subtotal / Sales Tax / Total — a bordered box at bottom-right, same
  // shape as QB's own template. All three rows always drawn (Subtotal and
  // Sales Tax blank/0.0% rather than dropped when this record has neither),
  // matching the sample invoice's shape exactly.
  const taxPct = header.salesTaxPercent != null ? header.salesTaxPercent.toFixed(1) : '0.0';
  const summaryRows: { label: string; value: string; bold?: boolean }[] = [
    { label: 'Subtotal', value: money(header.subtotal ?? null) },
    { label: `Sales Tax (${taxPct}%)`, value: money(header.salesTaxAmount ?? 0) },
    { label: 'Total', value: money(header.total), bold: true },
  ];
  const summaryHeight = summaryRows.length * 20;

  // The item table's own border/column lines extend all the way down near
  // the summary box regardless of how few lines there are — same as QB's
  // own template, where the item grid always fills the page rather than
  // shrink-wrapping its rows. Only on the page that still has the room: a
  // page that's already full from real rows just falls through unchanged.
  const itemsBottomTarget = MARGIN + summaryHeight + 70;
  if (y > itemsBottomTarget) {
    for (const cx of COL_LINES) vLine(cx, y, itemsBottomTarget);
    hLine(TABLE_LEFT, TABLE_RIGHT, itemsBottomTarget);
    y = itemsBottomTarget;
  }

  if (y - summaryHeight < MARGIN + 50) {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  }
  y -= 10;
  const summaryWidth = 220;
  const summaryX = TABLE_RIGHT - summaryWidth;
  strokeRect(summaryX, y - summaryHeight, summaryWidth, summaryHeight);
  summaryRows.forEach((row, i) => {
    const rowTop = y - i * 20;
    if (i > 0) hLine(summaryX, TABLE_RIGHT, rowTop);
    const f = row.bold ? bold : font;
    const size = row.bold ? 10.5 : 9;
    text(row.label, summaryX + 8, rowTop - 14, f, size);
    rightText(row.value, TABLE_RIGHT - 8, rowTop - 14, f, size);
  });
  y -= summaryHeight + 20;

  // Footer note — only when the company contact address is known (Settings
  // page), rather than hardcoding one company's accounting inbox.
  if (header.company?.contactEmail) {
    text('Please send any questions to', MARGIN, y, font, 8, rgb(0.35, 0.35, 0.35));
    text(header.company.contactEmail, MARGIN, y - 10, font, 8, rgb(0.35, 0.35, 0.35));
    text('Thank you for your business!', MARGIN, y - 22, font, 8, rgb(0.35, 0.35, 0.35));
  }

  return pdf.save();
}
