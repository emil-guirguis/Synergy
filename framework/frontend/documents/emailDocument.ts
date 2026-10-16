/**
 * Emailing a saved file: `shareDocumentFile` hands the file itself to the OS share
 * sheet, which opens the chosen mail app with the file already attached.
 *
 * That share sheet is the only route in a browser that both opens a real mail
 * client AND carries the bytes. `mailto:` has no attachment parameter at all (the
 * old Outlook-only `attachment=` was killed for security reasons), and an `.eml`
 * draft file only opens if the user opens it — besides leaving a file in their
 * downloads every time, which is what ruled it out here. The cost of the share
 * sheet is its app picker; callers whose browser offers no file sharing at all
 * fall back to sending server-side instead (EmailDocumentDialog).
 *
 * Recipient is never prefilled anywhere — the sender picks it in their mail app.
 */

/**
 * True when this browser can hand a real file to the OS share sheet. Chrome on
 * Windows/macOS/Android and Safari can; Firefox cannot, so callers need a plan B.
 */
export function canShareFiles(): boolean {
  try {
    const probe = new File([new Uint8Array([0])], 'probe.bin', { type: 'application/octet-stream' });
    return typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Default subject line for a file: its name without the extension, which reads
 * as a subject ("DENTCloud Brochure") where the raw file name does not
 * ("DENTCloud Brochure.pdf").
 */
export function subjectForFile(fileName: string): string {
  const base = (fileName || '').replace(/\.[^./\\]+$/, '').trim();
  return base || fileName || 'Document';
}

export interface ShareFileOptions {
  fileName: string;
  /** The file's bytes. */
  data: Blob | ArrayBuffer | Uint8Array;
  /** Defaults to the blob's type, else application/octet-stream. */
  mimeType?: string | null;
  /**
   * Subject. Defaults to `subjectForFile(fileName)`; passed to the OS as the
   * share title, which mail apps that read it use as the subject line.
   */
  title?: string;
  /**
   * Body text. Left out of the share payload entirely when empty — a share that
   * carries text as well as a file invites the receiving app to fill in fields
   * from it, so nothing is sent here unless the caller really has body text.
   */
  text?: string;
}

/** What the share attempt did, so the caller knows whether to try plan B. */
export type ShareFileResult =
  /** The OS took it — the user is in their mail app with the file attached. */
  | 'shared'
  /** The user dismissed the share sheet. Do nothing further. */
  | 'cancelled'
  /** This browser can't share files, or the OS refused. Caller should fall back. */
  | 'unsupported';

async function toBytes(data: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  // Duck-typed rather than `instanceof Uint8Array`: a typed array minted in another
  // realm (a worker, or Node's TextEncoder under jsdom) fails that check and would
  // fall through to .arrayBuffer(), which it doesn't have. ArrayBuffer.isView is
  // cross-realm safe.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (typeof (data as Blob).arrayBuffer === 'function') return new Uint8Array(await (data as Blob).arrayBuffer());
  return new Uint8Array(data as ArrayBuffer);
}

function mimeOf(data: Blob | ArrayBuffer | Uint8Array, mimeType?: string | null): string {
  const fromBlob = typeof Blob !== 'undefined' && data instanceof Blob ? data.type : '';
  return mimeType || fromBlob || 'application/octet-stream';
}

/**
 * Hands the file to the OS share sheet. The user picks their mail app and lands in
 * a compose window with the file attached — nothing is written to their disk.
 *
 * Must be called while the click's user activation is still live (~5 seconds in
 * Chrome): a slow byte fetch inside the handler can burn through it, and the OS
 * then refuses with NotAllowedError, reported here as 'unsupported'. Callers that
 * fetch bytes should start that fetch when the menu opens, not on the click.
 *
 * Subject/body are a request, not a guarantee: the receiving app decides what to
 * do with the share title and text, and some (notably the new Outlook for Windows)
 * take the file and ignore both.
 */
export async function shareDocumentFile(opts: ShareFileOptions): Promise<ShareFileResult> {
  if (!canShareFiles()) return 'unsupported';
  const bytes = await toBytes(opts.data);
  const file = new File([bytes as BlobPart], opts.fileName, { type: mimeOf(opts.data, opts.mimeType) });
  if (!navigator.canShare?.({ files: [file] })) return 'unsupported';
  const title = opts.title?.trim() || subjectForFile(opts.fileName);
  const text = opts.text?.trim();
  try {
    // `text` is omitted unless the caller actually has body text. Sending the
    // subject as text too (an earlier version did) gives the receiving app a
    // text payload alongside the file, which mail targets are free to interpret
    // however they like — including filling in fields the sender wanted blank.
    // Title alone is the smallest request that still names the subject.
    await navigator.share(text ? { files: [file], title, text } : { files: [file], title });
    return 'shared';
  } catch (e: any) {
    // Sheet dismissed — the user said no; the caller must not then go and do
    // something else with the file.
    if (e?.name === 'AbortError') return 'cancelled';
    return 'unsupported';
  }
}
