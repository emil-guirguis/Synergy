/**
 * Shared "email a PDF of this record" helpers — originally written for
 * aiChat.ts's email_order/email_invoice tools, moved here so the direct
 * REST routes (orders.ts's POST /:id/email) can reuse the exact same
 * PDF-build + send logic instead of duplicating it.
 */
import { Env, execQuery } from '../db';
import { sendMail } from '../mail';
import { buildDocumentPdf, money, type CompanyInfo, type DocumentHeader, type DocumentLine } from './documentPdf';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** pg returns `date` columns as JS Date objects — PDFs/emails need plain text. */
export function dateStr(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().split('T')[0] : String(v);
}

/** MM/DD/YYYY — how a date reads on the printed invoice/order (and in its
 *  email banner), not dateStr's ISO shape. */
export function formatMDY(v: unknown): string | null {
  const iso = dateStr(v);
  const m = iso && /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : iso;
}

export function toDocumentLines(raw: unknown): DocumentLine[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((l: any) => ({
    item: l?.item ?? null,
    description: l?.desc ?? null,
    quantity: l?.quantity != null ? Number(l.quantity) : null,
    rate: l?.rate != null ? Number(l.rate) : null,
    amount: l?.amount != null ? Number(l.amount) : null,
  }));
}

/** "City, ST ZIP" — the standard US postal line QB's own template uses
 *  (comma after city only, no comma before the ZIP). */
function cityStateZip(city: unknown, state: unknown, zip: unknown): string {
  const cs = [city, state].filter(Boolean).join(', ');
  return [cs, zip].filter(Boolean).join(' ');
}

/**
 * Pre-migration-120 fallback: invoices synced before BillAddressBlock was
 * captured (or not yet re-pulled — see migration 120's backfill note) have
 * no bill_address_block of their own, so reconstruct one from
 * qb_customer.bill_addr (migration 001's {addr1,addr2,city,state,postal}).
 * invoiceDocumentHeader prefers the real bill_address_block when present.
 */
export function formatInvoiceBillTo(customerName: string | null, billAddr: any): string | null {
  if (!billAddr) return customerName ?? null;
  const cityLine = cityStateZip(billAddr.city, billAddr.state, billAddr.postal);
  const lines = [customerName, billAddr.addr1, billAddr.addr2, cityLine]
    .filter(Boolean)
    // A test/dummy QB customer sometimes has its own name typed into
    // Address Line 1 too (seen live: "TEST COMPANY" both as the customer
    // name and as bill_addr.addr1) — drop the immediate repeat rather than
    // printing "TEST COMPANY" twice on the Bill To box.
    .filter((line, i, arr) => i === 0 || line !== arr[i - 1]);
  return lines.length ? lines.join('\n') : customerName ?? null;
}

/**
 * The company's own "Remit To" block (name/address) and the accounting
 * contact address the PDF footer names — public.company_settings is a
 * singleton row backing the Settings page. One extra query per PDF build;
 * same cost class as invoices.ts's avgDaysToPay aggregate.
 */
export async function loadCompanySettings(env: Env): Promise<CompanyInfo | null> {
  const { rows } = await execQuery(
    env,
    `SELECT name, street, street2, city, state, zip, contact_email
       FROM public.company_settings ORDER BY company_settings_id LIMIT 1`,
    [],
    'documentEmail.companySettings'
  );
  const row = rows[0];
  if (!row) return null;
  const cityLine = cityStateZip(row.city, row.state, row.zip);
  return {
    name: row.name ?? null,
    addressLines: [row.street, row.street2, cityLine].filter(Boolean),
    contactEmail: row.contact_email ?? null,
  };
}

/**
 * Row shape the three invoice-PDF callers all query: aiChat.ts's
 * email_invoice tool, routes/invoices.ts's GET /:id/pdf, and
 * sendInvoiceNoticeEmail. Everything beyond the original five fields is
 * migration 120's QB template data — optional so a caller that hasn't
 * joined/selected a given piece still compiles (it just renders blank,
 * the same "omit, don't fake" rule the PDF itself follows), but all three
 * real callers select every column below.
 */
export interface InvoiceDocumentRow {
  ref_number: string | null;
  customer_name: string | null;
  txn_date: unknown;
  due_date: unknown;
  total: number | string | null;
  /** qb_customer.bill_addr — fallback only, see formatInvoiceBillTo. */
  bill_addr: any;
  balance_remaining?: number | string | null;
  subtotal?: number | string | null;
  ship_date?: unknown;
  bill_address_block?: string | null;
  ship_address_block?: string | null;
  terms?: string | null;
  ship_via?: string | null;
  fob?: string | null;
  sales_tax_total?: number | string | null;
  sales_tax_percent?: number | string | null;
  po_number?: string | null;
  /** Joined qb_sales_rep.initial off sales_rep_list_id — the rep code
   *  ("SSS", "J") the printed template shows, not the rep's full name. */
  sales_rep?: string | null;
  /** Resolved via linked_txn -> qb_sales_order (first linked SalesOrder). */
  so_ref_number?: string | null;
  job_name?: string | null;
  /** Migration 121: QB's header <Other> text — the template's Freight Acct/Zip box. */
  freight_acct_zip?: string | null;
}

const numOrNull = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

/**
 * QB's "Customer:Job" CustomerRef split — looks like the real job name, but
 * verified against live data (2026-10-28) it's usually a distributor's
 * branch/location instead (e.g. "CED:CED - San Diego", "Crawford Electric
 * Supply:Crawford - Irving") — TBWC's customers are wholesale distributors
 * with branch sub-customers, not QB Jobs. The actual project name lives on
 * qb_sales_order.job_name, TBWC's own free-text field (migration 020) filled
 * in when the order is built, so invoiceDocumentHeader/orderDocumentHeader
 * prefer that and only fall back to this split when no linked order has one.
 */
export function qbJobNameFromCustomer(customerName: string | null | undefined): string | null {
  if (!customerName) return null;
  const parts = customerName.split(':');
  return parts.length > 1 ? parts[parts.length - 1].trim() || null : null;
}

export function invoiceDocumentHeader(row: InvoiceDocumentRow, company?: CompanyInfo | null): DocumentHeader {
  return {
    kind: 'Invoice',
    refNumber: row.ref_number,
    customerName: row.customer_name,
    billTo: row.bill_address_block || formatInvoiceBillTo(row.customer_name, row.bill_addr),
    shipTo: row.ship_address_block ?? null,
    date: formatMDY(row.txn_date),
    dueDate: formatMDY(row.due_date),
    shipDate: formatMDY(row.ship_date),
    // Unlike qb_sales_order.freight_terms (that company's Terms list holds
    // freight-handling codes on orders — migration 014), an invoice's own
    // TermsRef is a real payment term ("Net 30"), confirmed against invoice
    // #10459's printed PDF — see migration 120.
    termsLabel: 'Terms',
    terms: row.terms ?? null,
    soNumber: row.so_ref_number ?? null,
    poNumber: row.po_number ?? null,
    jobName: row.job_name ?? qbJobNameFromCustomer(row.customer_name) ?? null,
    rep: row.sales_rep ?? null,
    fob: row.fob ?? null,
    shipVia: row.ship_via ?? null,
    freightAcctZip: row.freight_acct_zip ?? null,
    subtotal: numOrNull(row.subtotal),
    salesTaxPercent: numOrNull(row.sales_tax_percent),
    salesTaxAmount: numOrNull(row.sales_tax_total),
    total: numOrNull(row.total),
    balanceDue: numOrNull(row.balance_remaining),
    company: company ?? null,
  };
}

/**
 * Row shape the two order-PDF callers query: aiChat.ts's email_order tool and
 * routes/orders.ts's loadOrderForEmail. qb_sales_order already carries most
 * of what the invoice side needed migration 120 for (bill/ship address
 * blocks, ship_via — migration 014); FOB and a real Sales Tax figure still
 * don't exist for orders (see pdf/documentPdf.ts's header for why FOB is
 * blank everywhere).
 */
export interface OrderDocumentRow {
  ref_number: string | null;
  customer_name: string | null;
  job_name: string | null;
  po_number: string | null;
  txn_date: unknown;
  total: number | string | null;
  bill_address_block: string | null;
  subtotal?: number | string | null;
  due_date?: unknown;
  ship_date?: unknown;
  ship_address_block?: string | null;
  /** QB TermsRef.FullName — this company's order-side Terms list holds
   *  freight codes (migration 014), not payment terms; labelled accordingly. */
  freight_terms?: string | null;
  ship_via?: string | null;
  sales_rep?: string | null;
}

export function orderDocumentHeader(row: OrderDocumentRow, company?: CompanyInfo | null): DocumentHeader {
  return {
    kind: 'Order',
    refNumber: row.ref_number,
    customerName: row.customer_name,
    billTo: row.bill_address_block,
    shipTo: row.ship_address_block ?? null,
    date: formatMDY(row.txn_date),
    dueDate: formatMDY(row.due_date),
    shipDate: formatMDY(row.ship_date),
    termsLabel: 'Freight Terms',
    terms: row.freight_terms ?? null,
    soNumber: null,
    poNumber: row.po_number,
    jobName: qbJobNameFromCustomer(row.customer_name) ?? row.job_name,
    rep: row.sales_rep ?? null,
    fob: null,
    shipVia: row.ship_via ?? null,
    subtotal: numOrNull(row.subtotal),
    salesTaxPercent: null,
    salesTaxAmount: null,
    total: numOrNull(row.total),
    company: company ?? null,
  };
}

/** No Buffer in the Workers runtime — chunked to stay well under engines'
 *  per-call argument limit for String.fromCharCode(...bytes). */
export function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Collection-notice subject/body — the AR tab's Email-notice action (single
 * row and the AR Aging report's bulk send both go through
 * routes/invoices.ts's sendInvoiceNoticeEmail, which calls these) and nowhere
 * else, so the wording lives in exactly one place server-side. Fixed
 * company copy/signature (TBWC, Inc) per the business-dictated template —
 * only the "Dear {customer}," salutation varies per invoice.
 */
export function lateInvoiceSubject(refNumber?: string | null): string {
  return refNumber ? `Past Due Invoice ${refNumber}` : 'Past Due Invoice';
}

export function lateInvoiceBody(opts: {
  customerName?: string | null;
}): string {
  const customer = opts.customerName?.trim() || 'Customer';
  return [
    `Dear ${customer},`,
    '',
    'Your invoice is attached. Please remit payment at your earliest convenience. Please also note the terms and conditions below.',
    '',
    'Thank you for your business - we appreciate it very much.',
    '',
    'Sincerely,',
    '',
    'TBWC, Inc',
    'Accounting@tbwcinc.com',
    'PH (888) 562-1810',
    '',
    '_____',
    'TBWC PAYMENT TERMS AND PENALTIES:',
    '',
    'Invoices must be paid within 30 days.',
    '',
    'Invoices past 30 days - If payment in full for invoice is not recieved within 5 business days of the first notice, the order will be sugject to a surcharge of 1.5% or $45 (whichever is greater).',
    '',
    'Invoices past 60 days - The order will be subject to an additional surcharge of 1.5% (totaling 3%) if payment in full is not received within 5 business days of the second notice.',
    '',
    'Invoices past 90 days - If payment for the invoice, having accrued a total of 3% in past due surcharges, has not been made, TBWC will no longer ship purchase orders received by this company. Failure to submit payment within 5-business days following a third and final notice will result in another 1.5% surcharge added to the original invoice and sent to collections.',
  ].join('\n');
}

export interface SendDocumentEmailOptions {
  /** Full message body (plain text, line breaks preserved) — e.g. the Email
   *  dialog's own "Hello, ... / Thanks, {name}" text, or sendInvoiceNoticeEmail's
   *  lateInvoiceBody. Used verbatim (just escaped) instead of the generic
   *  "Please find your {kind} attached" template, since a caller supplying
   *  this has already written its own greeting and signature. Omitted (the
   *  AI chat path) falls back to that template. Rendered inside the branded
   *  card body — see bannerHtml below. */
  message?: string | null;
  /** Overrides the default "{kind} {ref} from TBWC, Inc." subject (the PO
   *  Number suffix, when there is one, is still appended on top of this). */
  subject?: string | null;
  /** Where a reply should go — e.g. the order's assigned sales rep — since
   *  the envelope From is always the fixed system account (SMTP_FROM). */
  replyTo?: string | null;
  /** Extra recipient on the actual send — e.g. the AR collection-notice Cc
   *  to accounting@tbwcinc.com (routes/invoices.ts's sendInvoiceNoticeEmail).
   *  Carried into the stored .eml too, so the audit copy shows the same
   *  header the customer's own copy did. */
  cc?: string | null;
  /** Drop the TBWC logo image from the bottom of the body card — the AR
   *  collection-notice email (sendInvoiceNoticeEmail) opts into this so the
   *  notice ends with the past-due terms paragraph, not a logo. */
  hideLogo?: boolean;
}

/**
 * Hosted (not a data: URI) so Outlook actually renders it — Outlook Desktop's
 * Word-based HTML engine blocks inline base64 images in a lot of versions,
 * and the recipients here are exactly the Outlook/Exchange customers the
 * sample .eml came from. Served from tbwc-site's own site root (the same
 * file documentPdf.ts embeds for the PDF, confirmed byte-identical —
 * TBWC/frontend/src/assets/tbwc-logo.png), so there's one logo asset, not two.
 */
const TBWC_LOGO_URL = 'https://tbwctechnology.com/favicon.png';

/**
 * The branded card every order/invoice/AR-notice email renders inside —
 * banner with the company name, an Invoice/Order + Due Date + ref# block
 * beside an "Amount Due" figure, the message in a bordered body (the logo
 * again, under the signature — skipped when hideLogo, as the AR notice
 * does so its past-due terms paragraph is the last thing in the body), a
 * dark footer bar. Matches the email QuickBooks Desktop itself
 * sends when you email an invoice straight from QB (confirmed against a
 * real one, invoice #10522, 2026-10-27) — colors and layout copied from it
 * so a customer sees the same look whether the email came from QB or here.
 *
 * Sent as its own full HTML document (tbwc-site's send-mail edge fn uses
 * bareHtmlDocument for the 'document' type, not its own branded wrapEmail()
 * shell — see supabase/functions/_shared/mailer.ts in that repo) so this is
 * the whole visible email, not nested inside another card.
 */
function bannerHtml(header: DocumentHeader, refNumber: string, messageHtml: string, hideLogo?: boolean): string {
  const amountDue = header.balanceDue ?? header.total;
  const companyName = escapeHtml(header.company?.name?.trim() || 'TBWC, Inc.');
  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #c0d0e4;border-radius:6px;overflow:hidden;">` +
    `<tr><td style="background:#6E8BA8;padding:12px 20px;">` +
    `<span style="font-size:16px;font-family:Helvetica,Arial,sans-serif;font-weight:bold;color:#ffffff;">${companyName}</span>` +
    `</td></tr>` +
    `<tr><td style="background:#E6ECF4;padding:16px 20px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>` +
    `<td valign="top">` +
    `<div style="font-size:16px;font-family:Helvetica,Arial,sans-serif;font-weight:bold;color:#404040;">${escapeHtml(header.kind)}</div>` +
    (header.dueDate
      ? `<div style="font-size:10px;font-family:Helvetica,Arial,sans-serif;font-style:italic;color:#E77B07;margin-top:2px;">Due: ${escapeHtml(header.dueDate)}</div>`
      : '') +
    `<div style="font-size:13px;font-family:Helvetica,Arial,sans-serif;font-style:italic;color:#6E8BA8;margin-top:2px;">${escapeHtml(refNumber)}</div>` +
    `</td>` +
    (amountDue != null
      ? `<td valign="bottom" align="right"><span style="font-size:13px;font-family:Helvetica,Arial,sans-serif;color:#3E3E3E;">Amount Due: </span><span style="font-size:24px;font-family:Helvetica,Arial,sans-serif;color:#3E3E3E;">${money(amountDue)}</span></td>`
      : ''
    ) +
    `</tr></table>` +
    `</td></tr>` +
    `<tr><td style="padding:18px 20px;border-bottom:3px solid #E3EAF4;">` +
    `<div style="font-size:13px;font-family:Helvetica,Arial,sans-serif;line-height:1.6;color:#000000;">${messageHtml}</div>` +
    (hideLogo ? '' : `<img src="${TBWC_LOGO_URL}" width="110" alt="${companyName}" style="display:block;margin-top:16px;border:0;">`) +
    `</td></tr>` +
    `<tr><td style="background:#1F3246;padding:10px;">&nbsp;</td></tr>` +
    `</table>`
  );
}

/** Everything sendDocumentEmail needs to actually send, built once so the
 *  .eml writer below (buildDocumentEml) can reuse the exact same subject/
 *  body/attachment instead of re-deriving them and risking drift. */
async function buildDocumentEmailContent(
  header: DocumentHeader,
  lines: DocumentLine[],
  options: SendDocumentEmailOptions = {}
): Promise<{ subject: string; bodyHtml: string; pdfBytes: Uint8Array; attachmentFilename: string }> {
  const { message, subject: subjectOverride, hideLogo } = options;
  const pdfBytes = await buildDocumentPdf(header, lines);
  const refNumber = header.refNumber ?? '';
  const baseSubject = subjectOverride?.trim() || `${header.kind} ${refNumber} from TBWC, Inc.`.trim();
  const subject = header.poNumber ? `${baseSubject} [PO Number: ${header.poNumber}]` : baseSubject;

  const messageHtml = message?.trim()
    ? escapeHtml(message.trim()).replace(/\n/g, '<br>')
    : `Please find your ${header.kind.toLowerCase()} ${escapeHtml(refNumber)} attached` +
      `${header.total != null ? ` — total ${money(header.total)}` : ''}.`;
  const bodyHtml = bannerHtml(header, refNumber, messageHtml, hideLogo);
  return { subject, bodyHtml, pdfBytes, attachmentFilename: `${header.kind}-${refNumber || 'document'}.pdf` };
}

export async function sendDocumentEmail(
  env: Env,
  header: DocumentHeader,
  lines: DocumentLine[],
  recipientEmail: string,
  options: SendDocumentEmailOptions = {}
): Promise<string> {
  const { replyTo, cc } = options;
  const { subject, bodyHtml, pdfBytes, attachmentFilename } = await buildDocumentEmailContent(header, lines, options);

  await sendMail(env, {
    type: 'document',
    email: recipientEmail,
    subject,
    bodyHtml,
    replyTo: replyTo?.trim() || undefined,
    cc: cc?.trim() || undefined,
    attachmentBase64: uint8ToBase64(pdfBytes),
    attachmentFilename,
    attachmentContentType: 'application/pdf',
  });
  return JSON.stringify({ sent: true, recipient: recipientEmail, refNumber: header.refNumber });
}

/** Display From this Worker's own .eml files carry — same address the
 *  tbwc-site send-mail edge fn actually sends document email as
 *  (DOCUMENT_FROM there); kept in sync by hand since the two live in
 *  different repos/runtimes and nothing imports across that boundary. */
const EML_FROM = '"TBWC Accounting" <noreply@tbwcinc.com>';

function foldEmlHeader(name: string, value: string): string {
  // RFC 2822 §2.1.1 soft line limit (78 chars) — a long Subject (PO suffix,
  // long customer/ref text) folds into a continuation line with one leading
  // space, same as any mail client would write it.
  const line = `${name}: ${value}`;
  if (line.length <= 78) return line;
  const words = value.split(' ');
  const out: string[] = [];
  let cur = `${name}: `;
  for (const w of words) {
    if (cur.length + w.length > 78 && cur.trim().length > 0) {
      out.push(cur);
      cur = ' ';
    }
    cur += (cur.endsWith(' ') ? '' : ' ') + w;
  }
  out.push(cur);
  return out.join('\r\n');
}

/** Base64, wrapped at the standard MIME 76-char line length. */
function base64Wrapped(bytes: Uint8Array): string {
  const b64 = uint8ToBase64(bytes);
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) lines.push(b64.slice(i, i + 76));
  return lines.join('\r\n');
}

/**
 * Raw RFC 2822 message (multipart/mixed: HTML body + the PDF as a named
 * attachment) — a real .eml file. Not what actually goes out over SMTP
 * (tbwc-site's send-mail edge fn builds its own nodemailer message,
 * independently, from the same subject/bodyHtml/attachment this Worker
 * handed it), but byte-for-byte the same content, so double-clicking the
 * stored copy in Outlook shows the same email the customer got, PDF attached.
 */
function buildEmlBytes(opts: {
  to: string;
  cc?: string | null;
  subject: string;
  bodyHtml: string;
  attachmentBytes: Uint8Array;
  attachmentFilename: string;
  attachmentContentType: string;
}): Uint8Array {
  const boundary = `----tbwc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const headers = [
    foldEmlHeader('From', EML_FROM),
    foldEmlHeader('To', opts.to),
    ...(opts.cc?.trim() ? [foldEmlHeader('Cc', opts.cc.trim())] : []),
    foldEmlHeader('Subject', opts.subject),
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join('\r\n');

  const htmlPart =
    'Content-Type: text/html; charset="UTF-8"\r\n' +
    'Content-Transfer-Encoding: base64\r\n\r\n' +
    base64Wrapped(new TextEncoder().encode(opts.bodyHtml));

  const attachmentPart =
    `Content-Type: ${opts.attachmentContentType}; name="${opts.attachmentFilename}"\r\n` +
    'Content-Transfer-Encoding: base64\r\n' +
    `Content-Disposition: attachment; filename="${opts.attachmentFilename}"\r\n\r\n` +
    base64Wrapped(opts.attachmentBytes);

  const raw =
    `${headers}\r\n\r\n` +
    `--${boundary}\r\n${htmlPart}\r\n` +
    `--${boundary}\r\n${attachmentPart}\r\n` +
    `--${boundary}--\r\n`;
  return new TextEncoder().encode(raw);
}

/**
 * The .eml file stored as this document's audit-history record — built from
 * the exact subject/body/attachment sendDocumentEmail would send (or just
 * sent), not a re-render, so the saved copy can never drift from what the
 * customer actually received.
 */
export async function buildDocumentEml(
  header: DocumentHeader,
  lines: DocumentLine[],
  recipientEmail: string,
  options: SendDocumentEmailOptions = {}
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const { subject, bodyHtml, pdfBytes, attachmentFilename } = await buildDocumentEmailContent(header, lines, options);
  const bytes = buildEmlBytes({
    to: recipientEmail,
    cc: options.cc,
    subject,
    bodyHtml,
    attachmentBytes: pdfBytes,
    attachmentFilename,
    attachmentContentType: 'application/pdf',
  });
  return { bytes, fileName: `${attachmentFilename.replace(/\.pdf$/i, '')}.eml` };
}
