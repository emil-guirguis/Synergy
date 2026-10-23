/**
 * AI search — header search bar. Thin wrapper over the framework's document
 * search (@meterit/framework-backend/api/base/aiSearch): fast metadata pass
 * (file name / mime type / doc type) always, slow content pass opt-in via
 * POST /content once the user confirms from the "search file contents?"
 * prompt. TBWC has no other AI-searchable entities today — orders/customers
 * live behind their own list/filter UI, not this bar.
 *
 * Scoped by role, exactly like the AI chat's search_documents tool: both
 * passes see only the entity types the caller's own grants cover, and never an
 * 'employee'-typed resource file unless they hold resource:write (docAccess.ts
 * owns both rules). This used to run on authenticateToken alone, which made
 * the bar a way around every Documents grant and the Resources browser's
 * employee-only rule — a rep could read file names, and content snippets, from
 * every document in the system.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, permissionsFor } from '../middleware';
import { searchDocumentsMetadata, searchDocumentsContent } from '@meterit/framework-backend/api/base/aiSearch';
import { allowedDocEntityTypes, hiddenResourceDocIds, withoutHiddenDocs } from './docAccess';

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
    const permissions = await permissionsFor(c.env, c.get('user'));
    const entityTypes = allowedDocEntityTypes(permissions);
    const hidden = await hiddenResourceDocIds(c.env, permissions, entityTypes);
    const found = await searchDocumentsMetadata(execQuery, c.env, searchQuery, { entityTypes });
    const matches = withoutHiddenDocs(found.matches, hidden);
    // totalDocuments is the corpus size the search ran over — already narrowed
    // to this caller's entity types by the query above.
    const totalDocuments = found.totalDocuments;
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
    const permissions = await permissionsFor(c.env, c.get('user'));
    const entityTypes = allowedDocEntityTypes(permissions);
    const hidden = await hiddenResourceDocIds(c.env, permissions, entityTypes);
    const { results: raw, scanned, truncated } = await searchDocumentsContent(execQuery, c.env, searchQuery, { entityTypes });
    const docResults = withoutHiddenDocs(raw, hidden);
    const results = docResults.slice(offset, offset + limit).map((d) => ({
      id: d.documentId, name: d.fileName, type: 'document',
      docType: d.docType, mimeType: d.mimeType, entityType: d.entityType, entityId: d.entityId,
      fileSize: d.fileSize, snippet: d.snippet,
      // d.score is already a 0..1 ts_rank value (see aiSearch.ts's
      // searchDocumentsContent) — no /5 rescale needed like the old
      // occurrence-count score had.
      relevanceScore: d.score,
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
