/**
 * Shared "email a PDF of this record" helpers — originally written for
 * aiChat.ts's email_order/email_invoice tools, moved here so the direct
 * REST routes (orders.ts's POST /:id/email) can reuse the exact same
 * PDF-build + send logic instead of duplicating it.
 */
import { Env } from '../db';
import { sendMail } from '../mail';
import { buildDocumentPdf, money, type DocumentHeader, type DocumentLine } from './documentPdf';

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

/** pg returns `date` columns as JS Date objects — PDFs/emails need plain text. */
export function dateStr(v: unknown): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString().split('T')[0] : String(v);
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

export interface SendDocumentEmailOptions {
  /** Full message body (plain text, line breaks preserved) — e.g. the Email
   *  dialog's own "Hello, ... / Thanks, {name}" text. Used verbatim (just
   *  escaped) instead of the generic "Hi, / please find attached" template,
   *  since a caller supplying this has already written its own greeting and
   *  signature. Omitted (the AI chat path) falls back to that template. */
  message?: string | null;
  /** Overrides the default "{kind} {ref} from TBWC Technology" subject. */
  subject?: string | null;
  /** Where a reply should go — e.g. the order's assigned sales rep — since
   *  the envelope From is always the fixed system account (SMTP_FROM). */
  replyTo?: string | null;
}

export async function sendDocumentEmail(
  env: Env,
  header: DocumentHeader,
  lines: DocumentLine[],
  recipientEmail: string,
  options: SendDocumentEmailOptions = {}
): Promise<string> {
  const { message, subject: subjectOverride, replyTo } = options;
  const pdfBytes = await buildDocumentPdf(header, lines);
  const refNumber = header.refNumber ?? '';
  const subject = subjectOverride?.trim() || `${header.kind} ${refNumber} from TBWC Technology`.trim();

  let bodyHtml: string;
  if (message?.trim()) {
    bodyHtml = `<p style="margin:0;font-size:15px;line-height:1.6;color:#4b4e57;">${escapeHtml(message.trim()).replace(/\n/g, '<br>')}</p>`;
  } else {
    const defaultMessage =
      `Please find your ${header.kind.toLowerCase()} ${escapeHtml(refNumber)} attached` +
      `${header.total != null ? ` — total ${money(header.total)}` : ''}.`;
    bodyHtml =
      `<p style="margin:0 0 12px;font-size:15px;line-height:1.6;color:#4b4e57;">Hi,</p>` +
      `<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#4b4e57;">${defaultMessage}</p>` +
      `<p style="margin:0;font-size:13px;color:#7c7f89;">TBWC Technology</p>`;
  }

  await sendMail(env, {
    type: 'document',
    email: recipientEmail,
    subject,
    bodyHtml,
    replyTo: replyTo?.trim() || undefined,
    attachmentBase64: uint8ToBase64(pdfBytes),
    attachmentFilename: `${header.kind}-${refNumber || 'document'}.pdf`,
    attachmentContentType: 'application/pdf',
  });
  return JSON.stringify({ sent: true, recipient: recipientEmail, refNumber: header.refNumber });
}
