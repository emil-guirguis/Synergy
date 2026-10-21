import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchDocumentsMetadata, searchDocumentsContent, indexDocumentContent, backfillDocumentIndex } from './aiSearch';
import type { ExecQueryFn } from './crud';

function execQueryReturning(rows: any[]): ExecQueryFn {
  return vi.fn().mockResolvedValue({ rows, rowCount: rows.length });
}

describe('searchDocumentsMetadata', () => {
  it('matches a real file name even when extra words sit between the query words', async () => {
    // "Dent PowerScout Manual" isn't a literal substring of this file name —
    // "Meters Owners" sits in between — but every query word is present.
    const execQuery = execQueryReturning([
      { document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'Dent PowerScout Meters Owners Manual.pdf', mime_type: 'application/pdf', doc_type: 'manual', storage_bucket: 'b', storage_path: 'p', file_size: 100 },
      { document_id: 2, entity_type: 'resource', entity_id: '2', file_name: 'Unrelated Warranty Form.pdf', mime_type: 'application/pdf', doc_type: 'form', storage_bucket: 'b', storage_path: 'p2', file_size: 100 },
    ]);

    const { matches } = await searchDocumentsMetadata(execQuery, {}, 'Dent PowerScout Manual');

    expect(matches).toHaveLength(1);
    expect(matches[0].fileName).toBe('Dent PowerScout Meters Owners Manual.pdf');
  });

  it('still ranks an exact file name match above a partial word match', async () => {
    const execQuery = execQueryReturning([
      { document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'warranty.pdf', mime_type: 'application/pdf', doc_type: 'form', storage_bucket: 'b', storage_path: 'p', file_size: 100 },
      { document_id: 2, entity_type: 'resource', entity_id: '2', file_name: 'renewed-warranty.pdf', mime_type: 'application/pdf', doc_type: 'form', storage_bucket: 'b', storage_path: 'p2', file_size: 100 },
    ]);

    const { matches } = await searchDocumentsMetadata(execQuery, {}, 'warranty.pdf');

    expect(matches[0].fileName).toBe('warranty.pdf');
    expect(matches[0].score).toBeGreaterThan(matches[1].score);
  });

  it('returns no matches when no query word appears anywhere, with the full list as candidates to reason over', async () => {
    const execQuery = execQueryReturning([
      { document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'warranty.pdf', mime_type: 'application/pdf', doc_type: 'form', storage_bucket: 'b', storage_path: 'p', file_size: 100 },
    ]);

    const { matches, totalDocuments, candidates } = await searchDocumentsMetadata(execQuery, {}, 'zzznomatch');

    expect(matches).toHaveLength(0);
    expect(totalDocuments).toBe(1);
    expect(candidates).toEqual([{ documentId: 1, entityType: 'resource', fileName: 'warranty.pdf', docType: 'form' }]);
  });

  it('omits candidates when real matches were found', async () => {
    const execQuery = execQueryReturning([
      { document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'warranty.pdf', mime_type: 'application/pdf', doc_type: 'form', storage_bucket: 'b', storage_path: 'p', file_size: 100 },
    ]);

    const { candidates } = await searchDocumentsMetadata(execQuery, {}, 'warranty');

    expect(candidates).toBeUndefined();
  });

  it('omits candidates when there are no documents at all', async () => {
    const execQuery = execQueryReturning([]);

    const { matches, totalDocuments, candidates } = await searchDocumentsMetadata(execQuery, {}, 'anything');

    expect(matches).toHaveLength(0);
    expect(totalDocuments).toBe(0);
    expect(candidates).toBeUndefined();
  });
});

describe('searchDocumentsContent', () => {
  it('queries the search_vector index with an OR tsquery (not AND-ing every word) and maps rank/snippet', async () => {
    const execQuery = execQueryReturning([
      {
        document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'Service Agreement.pdf',
        mime_type: 'application/pdf', doc_type: 'other', storage_bucket: 'rep-docs', storage_path: 'x',
        file_size: 100, rank: 0.607_927, snippet: 'either party may <b>terminate</b> this agreement with 30 days notice',
      },
    ]);

    // "policy" is the user's own word, not necessarily the document's — an
    // AND-based query (websearch_to_tsquery's default for bare words) would
    // require the document to literally contain "policy" too and miss a real
    // match. OR + ts_rank lets partial-word-overlap documents still surface.
    const { results, scanned, truncated } = await searchDocumentsContent(execQuery, {}, 'termination policy');

    expect(execQuery).toHaveBeenCalledWith(
      {},
      expect.stringContaining("to_tsquery('english', $1)"),
      ['termination | policy', 50],
      'aiSearch.documents.content'
    );
    expect(results).toHaveLength(1);
    expect(results[0].fileName).toBe('Service Agreement.pdf');
    expect(results[0].snippet).toContain('terminate');
    expect(results[0].score).toBeCloseTo(0.607927, 5);
    expect(scanned).toBe(1);
    expect(truncated).toBe(false);
  });

  it('adds the entity_type filter when entityTypes is given', async () => {
    const execQuery = execQueryReturning([]);
    await searchDocumentsContent(execQuery, {}, 'warranty', { entityTypes: ['resource'] });
    expect(execQuery).toHaveBeenCalledWith(
      {},
      expect.stringContaining('entity_type = ANY($2)'),
      ['warranty', ['resource'], 50],
      'aiSearch.documents.content'
    );
  });

  it('strips punctuation from query words so they cannot inject a tsquery operator', async () => {
    const execQuery = execQueryReturning([]);
    await searchDocumentsContent(execQuery, {}, "warranty's | DROP");
    expect(execQuery).toHaveBeenCalledWith({}, expect.anything(), ['warrantys | drop', 50], 'aiSearch.documents.content');
  });

  it('keeps a thousands-grouped number intact as one token (matches the lexeme to_tsvector produces)', async () => {
    const execQuery = execQueryReturning([]);
    // Splitting on comma or stripping '.' would turn this into "127" / "85000",
    // neither of which equals the '127850.00' lexeme Postgres's own parser
    // stores for this number in search_vector — the match would silently miss.
    await searchDocumentsContent(execQuery, {}, '127,850.00');
    expect(execQuery).toHaveBeenCalledWith({}, expect.anything(), ['127,850.00', 50], 'aiSearch.documents.content');
  });

  it('clamps an unusually high rank to 1', async () => {
    const execQuery = execQueryReturning([
      { document_id: 1, entity_type: 'resource', entity_id: '1', file_name: 'xx.pdf', mime_type: null, doc_type: 'other', storage_bucket: 'b', storage_path: 'p', file_size: 1, rank: 5.2, snippet: 'xx' },
    ]);
    const { results } = await searchDocumentsContent(execQuery, {}, 'xx');
    expect(results[0].score).toBe(1);
  });

  it('short-circuits on a query with no words 2+ chars long, without hitting the DB', async () => {
    const execQuery = execQueryReturning([]);
    const { results } = await searchDocumentsContent(execQuery, {}, 'a');
    expect(results).toEqual([]);
    expect(execQuery).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty query without hitting the DB', async () => {
    const execQuery = execQueryReturning([]);
    const { results } = await searchDocumentsContent(execQuery, {}, '   ');
    expect(results).toEqual([]);
    expect(execQuery).not.toHaveBeenCalled();
  });

  it('short-circuits on an empty entityTypes array without hitting the DB', async () => {
    const execQuery = execQueryReturning([]);
    const { results } = await searchDocumentsContent(execQuery, {}, 'warranty', { entityTypes: [] });
    expect(results).toEqual([]);
    expect(execQuery).not.toHaveBeenCalled();
  });
});

describe('indexDocumentContent', () => {
  const ENV = { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'service-key' };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches, extracts, and stores extracted_text + search_vector', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hello world').buffer })
    );
    const execQuery = execQueryReturning([]);

    const ok = await indexDocumentContent(execQuery, ENV, {
      document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt',
    });

    expect(ok).toBe(true);
    expect(execQuery).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('UPDATE public.document'),
      [1, 'hello world'],
      'aiSearch.documents.index'
    );
  });

  it('caps extracted text at 500,000 chars (a raw data-dump spreadsheet blew a DB statement timeout at ~10MB of text)', async () => {
    const huge = 'x'.repeat(600_000);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode(huge).buffer })
    );
    const execQuery = execQueryReturning([]);

    await indexDocumentContent(execQuery, ENV, {
      document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt',
    });

    const written = (execQuery as any).mock.calls[0][2][1];
    expect(written.length).toBe(500_000);
  });

  it('strips a NUL byte from extracted text before writing (Postgres text columns reject it outright)', async () => {
    const withNul = 'before' + String.fromCharCode(0) + 'after';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode(withNul).buffer })
    );
    const execQuery = execQueryReturning([]);

    await indexDocumentContent(execQuery, ENV, {
      document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt',
    });

    expect(execQuery).toHaveBeenCalledWith(ENV, expect.anything(), [1, 'beforeafter'], 'aiSearch.documents.index');
  });

  it('returns false without writing when storage info is missing', async () => {
    const execQuery = execQueryReturning([]);
    const ok = await indexDocumentContent(execQuery, ENV, {
      document_id: 1, storage_bucket: null, storage_path: null, mime_type: 'text/plain', file_name: 'a.txt',
    });
    expect(ok).toBe(false);
    expect(execQuery).not.toHaveBeenCalled();
  });

  it('returns false without writing (so a later backfill can retry) when the fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const execQuery = execQueryReturning([]);
    const ok = await indexDocumentContent(execQuery, ENV, {
      document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt',
    });
    expect(ok).toBe(false);
    expect(execQuery).not.toHaveBeenCalled();
  });
});

describe('backfillDocumentIndex', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('indexes every un-indexed row it selects and reports indexed/attempted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hello').buffer })
    );
    const selectRows = [
      { document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt' },
      { document_id: 2, storage_bucket: 'rep-docs', storage_path: 'b.txt', mime_type: 'text/plain', file_name: 'b.txt' },
    ];
    const execQuery = vi.fn()
      .mockResolvedValueOnce({ rows: selectRows, rowCount: 2 }) // the backfill SELECT
      .mockResolvedValue({ rows: [], rowCount: 0 }); // each indexDocumentContent UPDATE

    const result = await backfillDocumentIndex(execQuery, { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });

    expect(result).toEqual({ indexed: 2, attempted: 2 });
    // SELECT, then per row: index_attempts bump UPDATE + indexDocumentContent's UPDATE.
    expect(execQuery).toHaveBeenCalledTimes(5);
    expect(execQuery.mock.calls[0][1]).toContain('extracted_text IS NULL');
  });

  it('counts a row it could not fetch as attempted but not indexed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const execQuery = vi.fn().mockResolvedValueOnce({
      rows: [{ document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt' }],
      rowCount: 1,
    });

    const result = await backfillDocumentIndex(execQuery, { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });

    expect(result).toEqual({ indexed: 0, attempted: 1 });
  });

  it("one row's UPDATE failure does not abort the rest of the batch (the exact crash that lost a 10k-doc backfill run)", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hello').buffer })
    );
    const selectRows = [
      { document_id: 1, storage_bucket: 'rep-docs', storage_path: 'a.txt', mime_type: 'text/plain', file_name: 'a.txt' },
      { document_id: 2, storage_bucket: 'rep-docs', storage_path: 'b.txt', mime_type: 'text/plain', file_name: 'b.txt' },
      { document_id: 3, storage_bucket: 'rep-docs', storage_path: 'c.txt', mime_type: 'text/plain', file_name: 'c.txt' },
    ];
    const execQuery = vi.fn()
      .mockResolvedValueOnce({ rows: selectRows, rowCount: 3 }) // the backfill SELECT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // doc 1's index_attempts bump
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // doc 1's UPDATE: ok
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // doc 2's index_attempts bump
      .mockRejectedValueOnce(new Error('invalid byte sequence for encoding "UTF8": 0x00')) // doc 2's UPDATE: fails
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // doc 3's index_attempts bump
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // doc 3's UPDATE: still runs

    const result = await backfillDocumentIndex(execQuery, { SUPABASE_URL: 'https://x.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });

    expect(result).toEqual({ indexed: 2, attempted: 3 });
    expect(execQuery).toHaveBeenCalledTimes(7);
  });
});
