/**
 * TBWC's permission catalog — the full set of `module:action` strings this
 * app's routes enforce. Lives in code because a permission only means something
 * if a route checks it: the framework ignores any granted permission that isn't
 * listed here, so a stale or hand-inserted role_permission row can never widen
 * access past what's written below.
 *
 * Adding a permission is a two-step change on purpose: add it here, and guard
 * the route with it. Creating a *role* needs neither — that's just rows.
 *
 * Child-row grids (quote lines, ...) are the one exception: their
 * permissions are derived from CHILD_SCHEMAS below (key:action for each of
 * the schema's parent.actions), so registering the schema is the catalog
 * change — the routes still guard with those same strings.
 */
import { childSchemaPermissions } from '@meterit/framework-backend/api/base/childRows';
import { quoteGridLineSchema } from './routes/quoteGridLineSchema';
import { userGridManagerSchema } from './routes/userGridManagerSchema';
import { orderGridLineSchema } from './routes/orderGridLineSchema';
import { invoiceGridLineSchema } from './routes/invoiceGridLineSchema';
import { paymentGridAppliedSchema } from './routes/paymentGridAppliedSchema';
import { inventoryGridKitItemSchema } from './routes/inventoryGridKitItemSchema';
import { documentGridSchema } from '@meterit/framework-backend/api/base/documentGridSchema';

/** Child-row grid schemas by permission/schema key — see framework childRows.ts. */
export const CHILD_SCHEMAS = {
  quoteGridLine: quoteGridLineSchema,
  userGridManager: userGridManagerSchema,
  orderGridLine: orderGridLineSchema,
  invoiceGridLine: invoiceGridLineSchema,
  paymentGridApplied: paymentGridAppliedSchema,
  inventoryGridKitItem: inventoryGridKitItemSchema,
  // Documents tab of each module (framework documents grid, public.document).
  // Keyed by the document row's entity_type in DOCUMENT_GRID_KEYS below.
  orderGridDocument: documentGridSchema('order'),
  quoteGridDocument: documentGridSchema('quote'),
  invoiceGridDocument: documentGridSchema('invoice'),
  inventoryGridDocument: documentGridSchema('inventory'),
  supportGridDocument: documentGridSchema('support'),
};

/** document.entity_type -> its Documents grid's permission key (routes/documents.ts, aiChat.ts). */
export const DOCUMENT_GRID_KEYS = {
  order: 'orderGridDocument',
  quote: 'quoteGridDocument',
  invoice: 'invoiceGridDocument',
  inventory: 'inventoryGridDocument',
  support_ticket: 'supportGridDocument',
} as const;

const STATIC_PERMISSIONS = [
  'order:read',
  'order:write',
  'order:delete',
  'quote:read',
  'quote:write',
  'quote:delete',
  'invoice:read',
  'customer:read',
  'payment:read',
  // The 3 nav: Reports sub-pages. Used to share one report:read — fine for
  // the backend gate, but it meant the roles tree couldn't show the 3 the
  // sidebar actually has, same problem Resources had with document:read.
  'repPerformance:read',
  'orderToCash:read',
  'invoiceTotals:read',
  'inventory:read',
  'inventory:write',
  'user:read',
  'user:write',
  'setting:read',
  'setting:write',
  // Per-record file attachments are no longer one flat document:read/write —
  // each module's Documents grid is its own child schema below
  // (orderGridDocument, quoteGridDocument, ...; migration 100).
  // The rep resource library (routes/docTypes.ts, nav: Utilities > Resources).
  // Used to be gated by document:read/write — same string as the unrelated
  // module above — which is why the roles tree only ever showed one "Document"
  // leaf under Utilities instead of the three the sidebar actually has.
  'resource:read',
  'resource:write',
  // Portal access requests (nav: Utilities > Rep Approvals). Previously
  // gated by is_admin + the unused users.can_approve_rep_leads column instead
  // of a role grant — see routes/AppRoutes.tsx history.
  'repApproval:write',
  // The notification bell/feed (nav: Utilities > Notifications). read = see
  // the feed, write = create/acknowledge, delete = clear.
  'notification:read',
  'notification:write',
  'notification:delete',
  'qbsync:read',
  'qbsync:run',
  'aichat:use',
  // Gates the AI chat run_sql_query tool specifically (arbitrary read-only SELECT
  // across the whole schema) — kept separate from aichat:use because that
  // permission only means "may use AI chat at all" now; every other AI tool is
  // gated by the real module permission it exposes (order:read, quote:read,
  // etc.) and scoped the same way the REST routes are. run_sql_query can't be
  // row-scoped after the fact (the model writes arbitrary free-form SQL), so it
  // stays its own explicit, admin-only grant rather than falling out of holding
  // several other permissions at 'all' scope. See routes/aiChat.ts.
  'aichat:sql',
  'dashboard:read',
  // Support tickets. read's scope is 'own' (just the tickets you filed) or
  // 'all' (every ticket, any filer) — see routes/support.ts. write gates the
  // admin-only edits (status/priority/type/assignee).
  'support:read',
  'support:write',
  // Role management (Settings > Roles) is gated by setting:read/setting:write
  // directly — see routes/roles.ts — not its own permission.
] as const;

export const PERMISSIONS: readonly string[] = [
  ...STATIC_PERMISSIONS,
  ...childSchemaPermissions(CHILD_SCHEMAS),
];

export type TbwcPermission = string;

/** Columns a caller owns a row through, per module — the `own` scope target. */
export const OWNER_COLUMN = {
  // NOT rep_id: order ownership comes from the QB sync (SalesRepRef), and
  // rep_id is a legacy column an admin would have had to set by hand. See the
  // header comment in routes/orders.ts.
  order: 'sales_rep_list_id',
  quote: 'sales_rep_list_id',
} as const;
