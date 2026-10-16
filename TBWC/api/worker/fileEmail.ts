/**
 * "Email this stored file to someone" — the send half shared by the Documents
 * grid (routes/documents.ts) and the rep portal's Resources browser
 * (routes/docTypes.ts). Both hold a file in a Supabase Storage bucket and want
 * it to arrive as a real attachment.
 *
 * Why the Worker sends it rather than the browser: nothing in a browser can put
 * a file into a mail client's draft. `mailto:` carries text only, an `.eml` draft
 * has to be downloaded and opened by hand (and the new Outlook for Windows app
 * refuses local `.eml` outright), and the Web Share API always pops an OS app
 * picker. Sending server-side skips all of that: no file ever lands on the
 * sender's disk and the attachment is always there.
 *
 * Envelope From is the fixed system account (SMTP_FROM, inside the tbwc-site
 * `send-mail` edge fn), so Reply-To carries whoever actually pressed Send — the
 * same arrangement orders/invoices use (pdf/documentEmail.ts).
 */
import { Env } from './db';
import { sendMail } from './mail';
import { escapeHtml, uint8ToBase64 } from './pdf/documentEmail';
import { fetchDocumentBytes } from '@meterit/framework-backend/api/base/aiSearch';

/**
 * Attachment ceiling. Deliberately well under the usual 25MB receiving limit:
 * the base64 encoding this goes out as costs another third on top, and the whole
 * file is held in the Worker's ~128MB of memory while that happens.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Thrown for bad input or an unsendable file; routes map these to a status. */
export class FileEmailError extends Error {
  readonly status: 400 | 404 | 413 | 502;
  constructor(message: string, status: 400 | 404 | 413 | 502) {
    super(message);
    this.name = 'FileEmailError';
    this.status = status;
  }
}

export interface StoredFile {
  bucket: string;
  path: string;
  fileName: string;
  mimeType?: string | null;
}

export interface EmailFileInput {
  /** Recipient. Blank is rejected — the sender types it, nothing is defaulted. */
  to?: unknown;
  subject?: unknown;
  message?: unknown;
  /** Where replies go; routes pass the authenticated caller's own address. */
  replyTo?: string | null;
}

// Deliberately loose: the point is to catch a typo'd or empty box before the
// edge function does, not to adjudicate RFC 5322.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function asTrimmedString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** One recipient, or a comma/semicolon-separated list. */
export function parseRecipients(raw: unknown): string[] {
  const list = asTrimmedString(raw)
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.length === 0) throw new FileEmailError('Enter at least one email address', 400);
  for (const address of list) {
    if (!EMAIL_RE.test(address)) throw new FileEmailError(`"${address}" is not a valid email address`, 400);
  }
  // The send-mail fn takes one recipient per call, so a list fans out below.
  if (list.length > 10) throw new FileEmailError('At most 10 recipients at a time', 400);
  return list;
}

/** The sender's own words, kept verbatim (escaped) — never a template around them. */
function bodyHtmlFor(message: string, fileName: string): string {
  const text = message || `Attached: ${fileName}`;
  return `<p style="margin:0;font-size:15px;line-height:1.6;color:#4b4e57;">${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
}

/**
 * Downloads the object with the service-role key and mails it on. Resolves with
 * the recipients it sent to; throws FileEmailError for anything a caller should
 * see as a 4xx/502.
 */
export async function emailStoredFile(env: Env, file: StoredFile, input: EmailFileInput): Promise<string[]> {
  const recipients = parseRecipients(input.to);
  // Same default as the UI's: the file name without its extension reads as a
  // subject line where "slip.pdf" does not.
  const subject = asTrimmedString(input.subject) || file.fileName.replace(/\.[^./\\]+$/, '') || file.fileName;
  const bodyHtml = bodyHtmlFor(asTrimmedString(input.message), file.fileName);

  if (!file.path) throw new FileEmailError('This document has no stored file', 404);
  // file_size on the row can lie (or be null) — the byte length below is the
  // real check, this one just avoids downloading 200MB to then refuse it.
  const bytes = await fetchDocumentBytes(env, file.bucket, file.path);
  if (!bytes) throw new FileEmailError('The stored file could not be read', 404);
  if (bytes.byteLength > MAX_EMAIL_ATTACHMENT_BYTES) {
    throw new FileEmailError(
      `${file.fileName} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB — too large to email ` +
        `(limit ${Math.round(MAX_EMAIL_ATTACHMENT_BYTES / 1024 / 1024)}MB). Use "Copy link" to send a link instead.`,
      413
    );
  }

  const attachmentBase64 = uint8ToBase64(new Uint8Array(bytes));
  for (const email of recipients) {
    try {
      await sendMail(env, {
        type: 'document',
        email,
        subject,
        bodyHtml,
        replyTo: input.replyTo?.trim() || undefined,
        attachmentBase64,
        attachmentFilename: file.fileName,
        attachmentContentType: file.mimeType || 'application/octet-stream',
      });
    } catch (e: any) {
      throw new FileEmailError(e?.message || 'Failed to send email', 502);
    }
  }
  return recipients;
}
