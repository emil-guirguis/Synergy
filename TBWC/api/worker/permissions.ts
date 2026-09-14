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
  'quote:read',
  'quote:write',
  'quote:delete',
  'invoice:read',
  'customer:read',
  'inventory:read',
  'inventory:write',
  'user:read',
  'user:write',
  'setting:read',
  'setting:write',
  'document:read',
  'document:write',
  'qbsync:read',
  'qbsync:run',
  'aichat:use',
  'dashboard:read',
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
  quote: 'rep_id',
} as const;
