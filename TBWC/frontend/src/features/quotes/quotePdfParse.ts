/**
 * Browser-side quote PDF parsing for QuoteImportPanel — ported from
 * api/scripts/import-quotes-from-folders.cjs's header/BOM parsers, but reads
 * only the first `maxPages` pages (default 3) instead of the whole document.
 *
 * unpdf's own extractText() always walks every page (Promise.all over
 * pdf.numPages) even when a caller slices the result afterward — the main
 * cost on a 20-50 page submittal-set PDF. getPageText() below calls
 * pdf.getPage(n).getTextContent() directly, one page at a time, so a huge
 * PDF only ever pays for the first 3 pages: the cover page (header/total)
 * plus the Bill-of-Materials table that follows it (pages 2-3 in every
 * sample seen so far).
 */
import { getDocumentProxy } from 'unpdf';

export interface ParsedQuoteLine {
  quantity: number;
  itemName: string;
  description: string;
  rate: number | null;
  amount: number | null;
}

export interface ParsedQuoteHeader {
  txnDate?: string;
  poc?: string;
  repName?: string;
  repEmail?: string;
  repPhone?: string;
  total?: number;
  engineerName?: string;
}

/** Same item-join as unpdf's internal getPageText — keeps the regexes below byte-identical to the .cjs scripts'. */
async function getPageText(pdf: any, pageNumber: number): Promise<string> {
  const page = await pdf.getPage(pageNumber);
  const content = await page.getTextContent();
  return content.items
    .filter((item: any) => item.str != null)
    .map((item: any) => item.str + (item.hasEOL ? '\n' : ''))
    .join('');
}

/** Reads only the first `maxPages` pages of the PDF — the actual speed fix. */
export async function extractFirstPages(file: File, maxPages = 3): Promise<string[]> {
  const buf = await file.arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const pageCount = Math.min(maxPages, pdf.numPages);
  const texts: string[] = [];
  for (let i = 1; i <= pageCount; i++) {
    texts.push(await getPageText(pdf, i));
  }
  return texts;
}

const LINE_RE = /^(\d+)\s+(\S+)\s+(.+)$/;
const PRICE_TAIL_RE = /\s*([\d,]+\.\d{2})\$\s+([\d,]+\.\d{2})\$\s*$/;
// Marks the start of the Bill-of-Materials table — item rows are only trusted
// after this, never from page-header text above it (e.g. a street address
// like "330 W Jones Ave" would otherwise false-match as qty=330, item=W).
const TABLE_HEADER_RE = /Product Description\s+MOQ/i;
const TABLE_END_RE = /ALL ORDERS ARE PLUS FREIGHT|Refer to ["“]TBWC/i;

export function parseLinesFromText(pageTexts: string[]): ParsedQuoteLine[] {
  const lines: ParsedQuoteLine[] = [];
  for (const pageText of pageTexts) {
    let inTable = false;
    for (const raw of pageText.split('\n')) {
      const line = raw.trim();
      if (TABLE_HEADER_RE.test(line)) {
        inTable = true;
        continue;
      }
      if (TABLE_END_RE.test(line)) {
        inTable = false;
        continue;
      }
      if (!inTable) continue;
      const m = line.match(LINE_RE);
      if (!m) continue;
      const [, qtyStr, partNumber, restRaw] = m;
      const words = restRaw.trim().split(/\s+/);
      if (words.length < 2) continue; // filters page-footer noise like "2 OF 4"
      let rest = restRaw.trim();
      let rate: number | null = null;
      let amount: number | null = null;
      const priceMatch = rest.match(PRICE_TAIL_RE);
      if (priceMatch) {
        rate = Number(priceMatch[1].replace(/,/g, ''));
        amount = Number(priceMatch[2].replace(/,/g, ''));
        rest = rest.slice(0, priceMatch.index).trim();
      }
      lines.push({ quantity: Number(qtyStr), itemName: partNumber, description: rest, rate, amount });
    }
  }
  return lines;
}

const NOISE_NAME_WORDS = /^(REPRESENTATIVE|PHONE|EMAIL ADDRESS|MOBILE|D-NET PRICE|TOTAL|UNIT AND PROJECT|PROJECT NOTES|BOM|TAKE-OFF)/i;

export function parseHeaderBlock(text: string): ParsedQuoteHeader {
  const header: ParsedQuoteHeader = {};

  const dateMatches = [...text.matchAll(/\b(\d{2})\/(\d{2})\/(\d{2})\b/g)];
  let latest: string | null = null;
  for (const [, mm, dd, yy] of dateMatches) {
    const iso = `20${yy}-${mm}-${dd}`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime()) && (!latest || iso > latest)) latest = iso;
  }
  if (latest) header.txnDate = latest;

  const poc = text.match(/POC:\s*([^\n]+)/i);
  if (poc) header.poc = poc[1].trim();

  const repIdx = text.search(/REPRESENTATIVE:/i);
  if (repIdx >= 0) {
    const block = text.slice(repIdx, repIdx + 500);
    const email = block.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const phone = block.match(/\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    const nameLine = block
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 3 && !l.includes('@') && !l.includes(':') && !l.includes('$') && !/\d/.test(l) && !NOISE_NAME_WORDS.test(l));
    if (email) header.repEmail = email[0];
    if (phone) header.repPhone = phone[0];
    if (nameLine) header.repName = nameLine;
  }

  const priceIdx = text.search(/D-NET PRICE:|GRAND TOTAL|TOTAL PRICE/i);
  if (priceIdx >= 0) {
    const block = text.slice(priceIdx, priceIdx + 300);
    const amounts = [...block.matchAll(/([\d,]+\.\d{2})\$/g)].map((m) => Number(m[1].replace(/,/g, '')));
    if (amounts.length) header.total = Math.max(...amounts);
  }

  const engineer = text.match(/ENGINEER(?:ING)?\s*(?:OF RECORD)?:\s*([^\n]+)/i);
  if (engineer) header.engineerName = engineer[1].trim();

  return header;
}

export function buildSalesRep(header: ParsedQuoteHeader): string | null {
  const parts: string[] = [];
  if (header.repName) parts.push(header.repName);
  const contact = [header.repEmail, header.repPhone].filter(Boolean).join(', ');
  if (contact) parts.push(`(${contact})`);
  return parts.join(' ') || null;
}

/**
 * Merges several page/file headers into one: txnDate takes the latest, total
 * takes the max (a revision's cover page sometimes lists component amounts
 * above the grand total, and the grand total is always the largest), every
 * other field takes the first non-null value seen. Used across every page of
 * one PDF AND across every quote-type PDF in a job folder, so a total that
 * only prints on, say, page 2 of a second revision still gets found instead
 * of stopping at the first file/page that didn't have one.
 */
export function mergeHeaders(parts: ParsedQuoteHeader[]): ParsedQuoteHeader {
  const merged: Record<string, string | number> = {};
  for (const h of parts) {
    for (const [k, v] of Object.entries(h)) {
      if (v == null) continue;
      if (k === 'txnDate') {
        if (!merged.txnDate || (v as string) > (merged.txnDate as string)) merged.txnDate = v as string;
      } else if (k === 'total') {
        if (!merged.total || (v as number) > (merged.total as number)) merged.total = v as number;
      } else if (merged[k] == null) {
        merged[k] = v;
      }
    }
  }
  return merged as ParsedQuoteHeader;
}

/**
 * Parses one quote-type PDF's first `maxPages` pages for both the cover-page
 * header and the BOM lines. The header is merged across ALL of those pages
 * (not just page 1) — some revisions print the grand total on page 2 instead
 * of the cover page.
 */
export async function extractQuotePdf(file: File, maxPages = 3): Promise<{ header: ParsedQuoteHeader; lines: ParsedQuoteLine[] }> {
  const pageTexts = await extractFirstPages(file, maxPages);
  const header = mergeHeaders(pageTexts.map(parseHeaderBlock));
  const lines = parseLinesFromText(pageTexts);
  return { header, lines };
}
