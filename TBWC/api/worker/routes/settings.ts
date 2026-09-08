/**
 * Company settings — org info + system config shown on the Settings page.
 * Singleton table (one row); admin-only, same as customers/inventory.
 * Row<->shape mapping lives in the framework base module so it stays
 * identical to MeterItPro's settings shape — see
 * framework/backend/api/base/settings.ts.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requireAdmin } from '../middleware';
import { rowToBasicSettings, basicSettingsToRow } from '@meterit/framework-backend/api/base/settings';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

app.use('*', authenticateToken);
app.use('*', requireAdmin);

const TABLE = 'company_settings';
const PK = 'company_settings_id';

async function loadRow(env: Env) {
  const result = await execQuery(
    env,
    `SELECT * FROM public.${TABLE} ORDER BY ${PK} LIMIT 1`,
    [],
    'settings.load'
  );
  return result.rows[0] ?? null;
}

app.get('/', async (c) => {
  const row = await loadRow(c.env);
  if (!row) return c.json({ success: false, message: 'Settings not found' }, 404);
  return c.json({ success: true, data: rowToBasicSettings(row) });
});

app.put('/', async (c) => {
  const existing = await loadRow(c.env);
  if (!existing) return c.json({ success: false, message: 'Settings not found' }, 404);

  const body = await c.req.json();
  const updateData = basicSettingsToRow(body);
  if (Object.keys(updateData).length === 0) {
    return c.json({ success: true, data: rowToBasicSettings(existing) });
  }

  const setClause: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(updateData)) {
    setClause.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  setClause.push('updated_at = NOW()');
  values.push(existing[PK]);

  const result = await execQuery(
    c.env,
    `UPDATE public.${TABLE} SET ${setClause.join(', ')} WHERE ${PK} = $${idx} RETURNING *`,
    values,
    'settings.update'
  );

  return c.json({
    success: true,
    data: rowToBasicSettings(result.rows[0]),
    message: 'Settings updated successfully',
  });
});

export default app;
