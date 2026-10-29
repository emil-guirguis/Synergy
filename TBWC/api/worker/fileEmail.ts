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
 * Envelope From is the fixed system sender (configured in the tbwc-site
 * `send-mail` edge fn), so Reply-To carries whoever actually pressed Send — the
 * same arrangement orders/invoices use (pdf/documentEmail.ts).
 */
import { Env } from './db';
import { sendMail } from './mail';
import { escapeHtml, uint8ToBase64 } from './pdf/documentEmail';
import { fetchDocumentBytes } from '@meterit/framework-backend/api/base/aiSearch';

/**
 * Attachment ceiling — set by Brevo now, not by the receiving mail server. Brevo
 * caps a single attachment at 4MB and the whole message (HTML content included)
 * at 20MB, and the base64 this goes out as costs another third on top, so ~3MB of
 * real file is what actually fits inside the 4MB. The previous 10MB ceiling came
 * from the old transport and would now be rejected by Brevo with a 400.
 *
 * Doubles as the memory guard it always was: the whole file sits in the Worker's
 * ~128MB while it is base64-encoded.
 */
export const MAX_EMAIL_ATTACHMENT_BYTES = 3 * 1024 * 1024;

/**
 * Extensions Brevo will accept on an attachment. Brevo infers an attachment's MIME
 * type from its filename and rejects the whole send (400 invalid_parameter) for
 * anything outside this list, so the file is screened here instead — a 400 naming
 * the offending file beats a 502 relaying Brevo's own error.
 *
 * Worth knowing: `eml` is absent while `msg` is present — Brevo's list, not ours.
 * The AR collection-notice audit copies this app stores are .eml files (see
 * routes/invoices.ts), so those rows can be downloaded but not emailed onward.
 */
export const BREVO_ATTACHMENT_EXTENSIONS = new Set([
  'aif', 'aifc', 'aiff', 'avi', 'bmp', 'cgm', 'css', 'csv', 'doc', 'docm', 'docx',
  'eps', 'ez', 'flac', 'gif', 'htm', 'html', 'ics', 'jpeg', 'jpg', 'm4a', 'm4v',
  'mkv', 'mobi', 'mov', 'mp3', 'mp4', 'mpeg', 'mpg', 'msg', 'ods', 'odt', 'ogg',
  'pdf', 'pkpass', 'png', 'ppt', 'pptx', 'pub', 'rtf', 'shtml', 'tar', 'tif',
  'tiff', 'txt', 'wav', 'wma', 'wmv', 'xls', 'xlsm', 'xlsx', 'xml', 'zip',
]);

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
  // Screened before the download, not after: Brevo would reject the send anyway,
  // and there is no reason to pull megabytes out of Storage to find that out.
  // dot >= 0, not > 0: Brevo reads the extension as whatever follows the last
  // dot, so a file named '.pdf' is a pdf to it. 'README' (no dot) and a trailing
  // dot both land on '', which the allowlist then refuses.
  const dot = file.fileName.lastIndexOf('.');
  const ext = dot >= 0 ? file.fileName.slice(dot + 1).toLowerCase() : '';
  if (!BREVO_ATTACHMENT_EXTENSIONS.has(ext)) {
    throw new FileEmailError(
      `${file.fileName} can’t be emailed — ${ext ? `.${ext} files are` : 'files with no extension are'} ` +
        'not an accepted attachment type. Use "Copy link" to send a link instead.',
      400
    );
  }
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
