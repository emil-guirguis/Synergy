/**
 * The share route is the whole email story now, so: the OS gets the real bytes
 * under the real filename, the subject defaults to the name minus extension, and
 * the three outcomes stay distinguishable — a caller must fall back on
 * 'unsupported' but do nothing at all on 'cancelled'.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { canShareFiles, shareDocumentFile, subjectForFile } from './emailDocument';

const bytes = (s: string) => new TextEncoder().encode(s);

/** jsdom's File has no .text(); FileReader is what it does implement. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

/** jsdom has no Web Share — stub it with the behaviour under test. */
function stubShare(share?: (data: any) => Promise<void>, canShare: (data: any) => boolean = () => true) {
  const fn = vi.fn(share ?? (async () => {}));
  Object.defineProperty(navigator, 'canShare', { value: canShare, configurable: true });
  Object.defineProperty(navigator, 'share', { value: fn, configurable: true });
  return fn;
}

function clearShareStubs() {
  // @ts-expect-error — removing the stubs from the shared navigator
  delete (navigator as any).share;
  // @ts-expect-error — same
  delete (navigator as any).canShare;
}

describe('subjectForFile', () => {
  it('drops the extension, which reads as a subject line', () => {
    expect(subjectForFile('DENTCloud Brochure.pdf')).toBe('DENTCloud Brochure');
    expect(subjectForFile('Invoice 1042.xlsx')).toBe('Invoice 1042');
  });

  it('keeps dots that are part of the name', () => {
    expect(subjectForFile('v1.2 spec.pdf')).toBe('v1.2 spec');
  });

  it('handles a name with no extension, and never returns empty', () => {
    expect(subjectForFile('Handbook')).toBe('Handbook');
    // A dotfile-style name has nothing left once the extension goes.
    expect(subjectForFile('.pdf')).toBe('.pdf');
    expect(subjectForFile('')).toBe('Document');
  });
});

describe('canShareFiles', () => {
  afterEach(clearShareStubs);

  it('is false when the browser has no canShare at all (Firefox)', () => {
    clearShareStubs();
    expect(canShareFiles()).toBe(false);
  });

  it('is false when canShare rejects files (share support, text only)', () => {
    stubShare(undefined, () => false);
    expect(canShareFiles()).toBe(false);
  });

  it('is true when the browser accepts a file payload', () => {
    stubShare();
    expect(canShareFiles()).toBe(true);
  });
});

describe('shareDocumentFile', () => {
  afterEach(() => {
    clearShareStubs();
    vi.restoreAllMocks();
  });

  it('hands the OS the real file, named and typed, and reports "shared"', async () => {
    const share = stubShare();

    const result = await shareDocumentFile({
      fileName: 'DENTCloud Brochure.pdf',
      data: bytes('%PDF-1.4'),
      mimeType: 'application/pdf',
    });

    expect(result).toBe('shared');
    const payload = share.mock.calls[0][0];
    const file = payload.files[0] as File;
    // The attachment keeps its real name; the subject drops the extension.
    expect(file.name).toBe('DENTCloud Brochure.pdf');
    expect(file.type).toBe('application/pdf');
    expect(await readAsText(file)).toBe('%PDF-1.4');
    expect(payload.title).toBe('DENTCloud Brochure');
  });

  it('sends title only — no text payload — when the caller has no body text', async () => {
    // A share carrying text as well as a file lets the receiving mail app
    // populate fields from that text, including a recipient the sender wanted
    // blank. Title alone still names the subject.
    const share = stubShare();
    await shareDocumentFile({ fileName: 'Packing Slip 88.pdf', data: bytes('x') });
    const payload = share.mock.calls[0][0];
    expect(payload.title).toBe('Packing Slip 88');
    expect('text' in payload).toBe(false);
  });

  it('omits a text payload that is only whitespace', async () => {
    const share = stubShare();
    await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x'), text: '   ' });
    expect('text' in share.mock.calls[0][0]).toBe(false);
  });

  it('carries text when the caller really has body text', async () => {
    const share = stubShare();
    await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x'), text: 'Latest brochure' });
    expect(share.mock.calls[0][0].text).toBe('Latest brochure');
  });

  it('lets a caller override the subject, ignoring a blank one', async () => {
    const share = stubShare();
    await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x'), title: 'Your order documents' });
    expect(share.mock.calls[0][0].title).toBe('Your order documents');

    await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x'), title: '  ' });
    expect(share.mock.calls[1][0].title).toBe('a');
  });

  it('accepts a Blob and takes its type when no mimeType is given', async () => {
    const share = stubShare();
    await shareDocumentFile({ fileName: 'a.png', data: new Blob([bytes('x')], { type: 'image/png' }) });
    expect((share.mock.calls[0][0].files[0] as File).type).toBe('image/png');
  });

  it('falls back to a generic type when neither the row nor the blob knows', async () => {
    const share = stubShare();
    await shareDocumentFile({ fileName: 'a.bin', data: bytes('x'), mimeType: null });
    expect((share.mock.calls[0][0].files[0] as File).type).toBe('application/octet-stream');
  });

  it('reports "cancelled" when the user dismisses the sheet', async () => {
    stubShare(async () => {
      throw Object.assign(new Error('Share canceled'), { name: 'AbortError' });
    });
    // Distinct from 'unsupported' precisely so the caller does NOT then open its
    // fallback dialog at someone who just said no.
    expect(await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x') })).toBe('cancelled');
  });

  it('reports "unsupported" when the browser cannot share files', async () => {
    clearShareStubs();
    expect(await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x') })).toBe('unsupported');
  });

  it('reports "unsupported" when the OS refuses the share (e.g. lost user activation)', async () => {
    stubShare(async () => {
      throw Object.assign(new Error('user gesture required'), { name: 'NotAllowedError' });
    });
    expect(await shareDocumentFile({ fileName: 'a.pdf', data: bytes('x') })).toBe('unsupported');
  });
});
