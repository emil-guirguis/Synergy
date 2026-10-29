/**
 * emailStoredFile is the only path by which a stored file leaves the system as an
 * attachment, so what matters here is input validation (a typo'd address must not
 * reach the mail fn), the size ceiling, and that the payload handed to send-mail
 * carries the real bytes under the real filename.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSendMail = vi.fn();
vi.mock('./mail', () => ({ sendMail: (...a: any[]) => mockSendMail(...a) }));

const mockFetchDocumentBytes = vi.fn();
vi.mock('@meterit/framework-backend/api/base/aiSearch', () => ({
  fetchDocumentBytes: (...a: any[]) => mockFetchDocumentBytes(...a),
}));

import { emailStoredFile, FileEmailError, MAX_EMAIL_ATTACHMENT_BYTES, parseRecipients } from './fileEmail';

const ENV = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' } as any;
const FILE = { bucket: 'record-docs', path: 'order/1/a-slip.pdf', fileName: 'slip.pdf', mimeType: 'application/pdf' };
const bytesOf = (s: string) => new TextEncoder().encode(s).buffer;

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchDocumentBytes.mockResolvedValue(bytesOf('%PDF-1.4 hello'));
  mockSendMail.mockResolvedValue(undefined);
});

describe('parseRecipients', () => {
  it('splits on commas and semicolons', () => {
    expect(parseRecipients('a@x.com, b@y.com; c@z.com')).toEqual(['a@x.com', 'b@y.com', 'c@z.com']);
  });

  it('rejects an empty box and a malformed address', () => {
    expect(() => parseRecipients('')).toThrow(/at least one email/i);
    expect(() => parseRecipients('   ')).toThrow(/at least one email/i);
    expect(() => parseRecipients('not-an-email')).toThrow(/not a valid email/i);
    expect(() => parseRecipients('a@x.com, bogus')).toThrow(/"bogus" is not a valid/);
  });

  it('caps a single send at 10 recipients', () => {
    const many = Array.from({ length: 11 }, (_, i) => `u${i}@x.com`).join(',');
    expect(() => parseRecipients(many)).toThrow(/At most 10 recipients/);
  });
});

describe('emailStoredFile', () => {
  it('sends the file as a base64 attachment under its own name and type', async () => {
    const recipients = await emailStoredFile(ENV, FILE, { to: 'c@x.com', subject: 'Slip', message: 'Hi there' });

    expect(recipients).toEqual(['c@x.com']);
    expect(mockFetchDocumentBytes).toHaveBeenCalledWith(ENV, 'record-docs', 'order/1/a-slip.pdf');
    const payload = mockSendMail.mock.calls[0][1];
    expect(payload).toMatchObject({
      type: 'document',
      email: 'c@x.com',
      subject: 'Slip',
      attachmentFilename: 'slip.pdf',
      attachmentContentType: 'application/pdf',
    });
    expect(atob(payload.attachmentBase64)).toBe('%PDF-1.4 hello');
  });

  it('defaults the subject to the file name minus its extension', async () => {
    // Same default the UI shows, so a send from either side reads the same.
    await emailStoredFile(ENV, FILE, { to: 'c@x.com' });
    expect(mockSendMail.mock.calls[0][1].subject).toBe('slip');
    // The attachment itself keeps the real name, extension and all.
    expect(mockSendMail.mock.calls[0][1].attachmentFilename).toBe('slip.pdf');
  });

  it('falls back to the raw name when there is nothing left without the extension', async () => {
    await emailStoredFile(ENV, { ...FILE, fileName: '.pdf' }, { to: 'c@x.com' });
    expect(mockSendMail.mock.calls[0][1].subject).toBe('.pdf');
  });

  it('keeps the sender’s message verbatim, HTML-escaped, with line breaks', async () => {
    await emailStoredFile(ENV, FILE, { to: 'c@x.com', message: 'Line 1\nR&D <here>' });
    const html = mockSendMail.mock.calls[0][1].bodyHtml;
    expect(html).toContain('Line 1<br>R&amp;D &lt;here&gt;');
  });

  it('passes reply-to through so replies reach the sender', async () => {
    await emailStoredFile(ENV, FILE, { to: 'c@x.com', replyTo: ' rep@tbwc.test ' });
    expect(mockSendMail.mock.calls[0][1].replyTo).toBe('rep@tbwc.test');
  });

  it('fans a recipient list out into one send each, encoding the bytes once', async () => {
    const recipients = await emailStoredFile(ENV, FILE, { to: 'a@x.com, b@y.com' });
    expect(recipients).toEqual(['a@x.com', 'b@y.com']);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
    expect(mockFetchDocumentBytes).toHaveBeenCalledTimes(1);
    expect(mockSendMail.mock.calls[0][1].attachmentBase64).toBe(mockSendMail.mock.calls[1][1].attachmentBase64);
  });

  it('validates the address before downloading anything', async () => {
    await expect(emailStoredFile(ENV, FILE, { to: 'bogus' })).rejects.toThrow(FileEmailError);
    expect(mockFetchDocumentBytes).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('404s a document with no stored path, and one whose bytes are gone', async () => {
    await expect(emailStoredFile(ENV, { ...FILE, path: '' }, { to: 'c@x.com' })).rejects.toMatchObject({ status: 404 });

    mockFetchDocumentBytes.mockResolvedValue(null);
    await expect(emailStoredFile(ENV, FILE, { to: 'c@x.com' })).rejects.toMatchObject({ status: 404 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('400s an extension Brevo will not accept, before downloading the bytes', async () => {
    // Brevo infers an attachment type from the filename and 400s the whole send
    // for anything off its allowlist. '.eml' is off it (while '.msg' is on it), and
    // the AR collection-notice audit copies are .eml - so this path is reachable
    // from the Documents grid, not hypothetical.
    await expect(emailStoredFile(ENV, { ...FILE, fileName: 'AR-Notice-2.eml' }, { to: 'c@x.com' }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockFetchDocumentBytes).not.toHaveBeenCalled();
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('400s a file with no extension at all', async () => {
    await expect(emailStoredFile(ENV, { ...FILE, fileName: 'README' }, { to: 'c@x.com' }))
      .rejects.toMatchObject({ status: 400 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('413s a file over the attachment ceiling rather than base64ing it', async () => {
    mockFetchDocumentBytes.mockResolvedValue(new ArrayBuffer(MAX_EMAIL_ATTACHMENT_BYTES + 1));
    await expect(emailStoredFile(ENV, FILE, { to: 'c@x.com' })).rejects.toMatchObject({ status: 413 });
    expect(mockSendMail).not.toHaveBeenCalled();
  });

  it('falls back to a generic content type when the row has none', async () => {
    await emailStoredFile(ENV, { ...FILE, mimeType: null }, { to: 'c@x.com' });
    expect(mockSendMail.mock.calls[0][1].attachmentContentType).toBe('application/octet-stream');
  });

  it('surfaces a mail-fn failure as a 502', async () => {
    mockSendMail.mockRejectedValue(new Error('send-mail failed (500)'));
    await expect(emailStoredFile(ENV, FILE, { to: 'c@x.com' })).rejects.toMatchObject({
      status: 502,
      message: 'send-mail failed (500)',
    });
  });
});
