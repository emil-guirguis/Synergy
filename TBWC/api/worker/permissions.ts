/**
 * TBWC's permission catalog — the full set of `module:action` strings this
 * app's routes enforce. Lives in code because a permission only means something
 * if a route checks it: the framework ignores any granted permission that isn't
 * listed here, so a stale or hand-inserted role_permission row can never widen
 * access past what's written below.
 *
 * Adding a permission is a two-step change on purpose: add it here, and guard
 * the route with it. Creating a *role* needs neither — that's just rows.
 */
export const PERMISSIONS = [
  'order:read',
  'order:write',
  'order:delete',
  'estimate:read',
  'estimate:write',
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
  // Generic order/invoice/inventory file attachments (routes/documents.ts) —
  // not the Resources library below, which looked identical until a role
  // couldn't actually tell them apart in the tree.
  'document:read',
  'document:write',
  // The rep resource library (routes/docTypes.ts, nav: Utilities > Resources).
  // Used to be gated by document:read/write — same string as the unrelated
  // module above — which is why the roles tree only ever showed one "Document"
  // leaf under Utilities instead of the three the sidebar actually has.
  'resource:read',
  'resource:write',
  // Rep Portal access requests (nav: Utilities > Rep Approvals). Previously
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
  'dashboard:read',
  // Support tickets. read's scope is 'own' (just the tickets you filed) or
  // 'all' (every ticket, any filer) — see routes/support.ts. write gates the
  // admin-only edits (status/priority/type/assignee).
  'support:read',
  'support:write',
  // Managing the roles themselves. Separate from setting:* even though the UI
  // lives in Settings: granting someone role:write lets them grant themselves
  // anything else, so it should be possible to hand out org settings without it.
  'role:read',
  'role:write',
] as const;

export type TbwcPermission = (typeof PERMISSIONS)[number];

/** Columns a caller owns a row through, per module — the `own` scope target. */
export const OWNER_COLUMN = {
  // NOT rep_id: order ownership comes from the QB sync (SalesRepRef), and
  // rep_id is a legacy column an admin would have had to set by hand. See the
  // header comment in routes/orders.ts.
  order: 'sales_rep_list_id',
  estimate: 'sales_rep_list_id',
} as const;
