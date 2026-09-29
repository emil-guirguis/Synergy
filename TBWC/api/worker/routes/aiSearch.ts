/**
 * AI search — header search bar. Thin wrapper over the framework's document
 * search (@meterit/framework-backend/api/base/aiSearch): fast metadata pass
 * (file name / mime type / doc type) always, slow content pass opt-in via
 * POST /content once the user confirms from the "search file contents?"
 * prompt. TBWC has no other AI-searchable entities today — orders/customers
 * live behind their own list/filter UI, not this bar.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import { searchDocumentsMetadata, searchDocumentsContent } from '@meterit/framework-backend/api/base/aiSearch';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

function validateSearchBody(body: any): { code: string; message: string } | null {
  const { query: searchQuery, limit = 20, offset = 0 } = body;
  if (!searchQuery || typeof searchQuery !== 'string' || searchQuery.trim().length === 0) {
    return { code: 'INVALID_QUERY', message: 'Query is required and must be a non-empty string' };
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    return { code: 'INVALID_LIMIT', message: 'Limit must be a positive integer' };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { code: 'INVALID_OFFSET', message: 'Offset must be a non-negative integer' };
  }
  return null;
}

app.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const invalid = validateSearchBody(body);
    if (invalid) return c.json({ success: false, error: invalid }, 400);
    const { query: searchQuery, limit = 20, offset = 0 } = body;

    const startTime = Date.now();
    const { matches, totalDocuments } = await searchDocumentsMetadata(execQuery, c.env, searchQuery);
    const results = matches.slice(offset, offset + limit).map((d) => ({
      id: d.documentId, name: d.fileName, type: 'document',
      docType: d.docType, mimeType: d.mimeType, entityType: d.entityType, entityId: d.entityId,
      fileSize: d.fileSize,
      relevanceScore: Math.min(d.score / 10, 1.0),
    }));

    return c.json({
      success: true,
      data: {
        results,
        total: matches.length,
        clarifications: [],
        executionTime: Date.now() - startTime,
        documentsTotal: totalDocuments,
      },
    });
  } catch (error: any) {
    console.error('[AI_SEARCH] Error:', error.message);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An error occurred while processing your search' } }, 500);
  }
});

app.post('/content', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const invalid = validateSearchBody(body);
    if (invalid) return c.json({ success: false, error: invalid }, 400);
    const { query: searchQuery, limit = 20, offset = 0 } = body;

    const startTime = Date.now();
    const { results: docResults, scanned, truncated } = await searchDocumentsContent(execQuery, c.env, searchQuery);
    const results = docResults.slice(offset, offset + limit).map((d) => ({
      id: d.documentId, name: d.fileName, type: 'document',
      docType: d.docType, mimeType: d.mimeType, entityType: d.entityType, entityId: d.entityId,
      fileSize: d.fileSize, snippet: d.snippet,
      relevanceScore: Math.min(d.score / 5, 1.0),
    }));

    return c.json({
      success: true,
      data: { results, total: docResults.length, scanned, truncated, executionTime: Date.now() - startTime },
    });
  } catch (error: any) {
    console.error('[AI_SEARCH_CONTENT] Error:', error.message);
    return c.json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'An error occurred while searching document contents' } }, 500);
  }
});

export default app;
