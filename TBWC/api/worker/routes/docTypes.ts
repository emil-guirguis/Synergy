/**
 * Type ('rep' | 'employee' | 'all') for each file in the Supabase `rep-docs`
 * Storage bucket. Table public.rep_doc_type, PK rep_doc_type_id — see
 * migrations/015-rep-doc-type.sql for why this lives here instead of on the
 * bucket object itself.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TYPES = ['rep', 'employee', 'all'] as const;
type DocType = (typeof TYPES)[number];

function isDocType(v: unknown): v is DocType {
  return typeof v === 'string' && (TYPES as readonly string[]).includes(v);
}

// { "Category/file.pdf": "rep", ... } for every file that has a type set.
// Files with no row default to 'all' on the client.
app.get('/', async (c) => {
  const result = await execQuery(c.env, 'SELECT doc_path, doc_type FROM public.rep_doc_type');
  const data: Record<string, DocType> = {};
  for (const row of result.rows) data[row.doc_path] = row.doc_type;
  return c.json({ success: true, data });
});

app.put('/', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { path, type } = body as { path?: string; type?: string };
  if (!path) return c.json({ success: false, message: 'path is required' }, 400);
  if (!isDocType(type)) return c.json({ success: false, message: 'type must be rep, employee, or all' }, 400);

  await execQuery(
    c.env,
    `INSERT INTO public.rep_doc_type (doc_path, doc_type, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (doc_path) DO UPDATE SET doc_type = EXCLUDED.doc_type, updated_at = now()`,
    [path, type],
    'docTypes.upsert'
  );
  return c.json({ success: true });
});

app.patch('/', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { fromPath, toPath } = body as { fromPath?: string; toPath?: string };
  if (!fromPath || !toPath) return c.json({ success: false, message: 'fromPath and toPath are required' }, 400);

  await execQuery(
    c.env,
    `UPDATE public.rep_doc_type SET doc_path = $2, updated_at = now() WHERE doc_path = $1`,
    [fromPath, toPath],
    'docTypes.rename'
  );
  return c.json({ success: true });
});

app.delete('/', requireAdmin, async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { path } = body as { path?: string };
  if (!path) return c.json({ success: false, message: 'path is required' }, 400);

  await execQuery(c.env, 'DELETE FROM public.rep_doc_type WHERE doc_path = $1', [path], 'docTypes.delete');
  return c.json({ success: true });
});

export default app;
