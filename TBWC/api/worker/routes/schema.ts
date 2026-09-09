/**
 * Schema routes — serve defineSchema() JSON to the framework's schemaLoader.
 * GET /api/schema/:entity -> { success: true, data: <schema.toJSON()> }
 *
 * The `user` schema is post-processed: its `qb_sales_rep_id` SELECT is populated
 * with live options from public.qb_sales_rep so the admin form shows a dropdown
 * of QuickBooks sales reps (initial + name) that stays current without a rebuild.
 *
 * The `order` schema's `sales_rep_list_id` (an entityField, not list/form-shown —
 * it only exists to carry filter options) is populated the same way but keyed
 * by qb_sales_rep.list_id, since that's what qb_sales_order.sales_rep_list_id
 * stores (the QB SalesRepRef ListID), not the qb_sales_rep table's own PK.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken } from '../middleware';
import { usersSchema } from './usersSchema';
import { orderSchema } from './orderSchema';
import { inventorySchema } from './inventorySchema';
import { quoteSchema } from './quoteSchema';
import { customersSchema } from './customersSchema';
import { invoicesSchema } from './invoicesSchema';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const schemas: Record<string, any> = {
  user: usersSchema,
  order: orderSchema,
  inventory: inventorySchema,
  quote: quoteSchema,
  customer: customersSchema,
  invoice: invoicesSchema,
};

/** Load active QB sales reps as SELECT enum values + labels ("BW - Bob Wilson"). */
async function salesRepOptions(env: Env): Promise<{ values: string[]; labels: Record<string, string> }> {
  const r = await execQuery(
    env,
    `SELECT qb_sales_rep_id, initial, name
       FROM public.qb_sales_rep
      WHERE is_active IS NOT FALSE
      ORDER BY initial NULLS LAST, name NULLS LAST`,
    [],
    'schema.user.salesRepOptions'
  );
  const values: string[] = [];
  const labels: Record<string, string> = {};
  for (const row of r.rows) {
    const id = String(row.qb_sales_rep_id);
    const parts = [row.initial, row.name].filter(Boolean);
    values.push(id);
    labels[id] = parts.length ? parts.join(' - ') : `Rep ${id}`;
  }
  return { values, labels };
}

/** Same as salesRepOptions(), keyed by list_id instead of qb_sales_rep_id. */
async function salesRepListIdOptions(env: Env): Promise<{ values: string[]; labels: Record<string, string> }> {
  const r = await execQuery(
    env,
    `SELECT list_id, initial, name
       FROM public.qb_sales_rep
      WHERE is_active IS NOT FALSE
      ORDER BY initial NULLS LAST, name NULLS LAST`,
    [],
    'schema.order.salesRepListIdOptions'
  );
  const values: string[] = [];
  const labels: Record<string, string> = {};
  for (const row of r.rows) {
    const parts = [row.initial, row.name].filter(Boolean);
    values.push(row.list_id);
    labels[row.list_id] = parts.length ? parts.join(' - ') : row.list_id;
  }
  return { values, labels };
}

/** Set enumValues/enumLabels on a field wherever it appears (formFields + formTabs + entityFields). */
function injectFieldOptions(json: any, fieldName: string, values: string[], labels: Record<string, string>): void {
  const ff = json.formFields?.[fieldName] ?? json.entityFields?.[fieldName];
  if (ff) { ff.enumValues = values; ff.enumLabels = labels; }
  for (const tab of json.formTabs ?? []) {
    for (const sec of tab.sections ?? []) {
      for (const f of sec.fields ?? []) {
        if (f?.name === fieldName) { f.enumValues = values; f.enumLabels = labels; }
      }
    }
  }
}

app.get('/:entity', async (c) => {
  const entity = c.req.param('entity');
  const schema = schemas[entity];
  if (!schema) return c.json({ success: false, message: `Unknown schema: ${entity}` }, 404);

  const json = schema.toJSON();

  if (entity === 'user') {
    const { values, labels } = await salesRepOptions(c.env);
    injectFieldOptions(json, 'qb_sales_rep_id', values, labels);
  }

  if (entity === 'order') {
    const { values, labels } = await salesRepListIdOptions(c.env);
    injectFieldOptions(json, 'sales_rep_list_id', values, labels);
  }

  return c.json({ success: true, data: json });
});

export default app;
