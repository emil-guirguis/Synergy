/**
 * Settings > AI Memory — read-only viewer over the shared public.ai_memory
 * table (see framework/backend/db/ai_memory.sql). Claude owns writes via the
 * memory_20250818 tool wired in routes/aiChat.ts; this route only lists.
 * Multi-tenant: scoped to the caller's tenant, same as every other route here.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';
import { listMemoryFiles } from '@meterit/framework-backend/api/base/aiMemory';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('settings:read'));

app.get('/', async (c) => {
  const tenantId = c.get('tenantId');
  const files = await listMemoryFiles((sql, params) => execQuery(c.env, sql, params, 'ai_memory'), tenantId);
  return c.json({ success: true, data: { files } });
});

export default app;
