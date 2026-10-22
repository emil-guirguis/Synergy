/**
 * DASHBOARD schema — not a record form. Its "fields" are the cards on the
 * landing page, so Settings > Roles > Dashboard lists them with a checkbox
 * each (fieldSectionLabel renames the section to "Cards"), stored as plain
 * field_access view bits on `dashboard:read` exactly like a form field's.
 *
 * Why fields and not permissions: a permission has to be enforced by a route
 * to mean anything (see permissions.ts's header), and no route serves a card —
 * each one reads a module the caller already has a grant for. So which cards a
 * role SEES is a view rule, and DashboardPage checks both this bit and the
 * grant behind the data (an own-scoped role ticking "Receivables" on still
 * doesn't get company AR — see the page's own comment).
 *
 * `card:<id>` matches the ids DashboardPage uses; the labels are what the
 * cards call themselves on screen. Adding a card means adding it here and
 * checking it there — the one pairing to keep in step.
 */
import { defineSchema, field, FieldTypes } from '@meterit/framework-backend/api/base/SchemaDefinition';

/** No dbField anywhere: nothing here is a column, and nothing is saved. */
const card = (name: string, order: number, label: string, description: string) =>
  field({ name, order, type: FieldTypes.BOOLEAN, default: true, label, description, showOn: ['form'] });

export const dashboardSchema = defineSchema({
  entityName: 'Dashboard',
  tableName: 'dashboard',
  description: 'The cards on the dashboard, per role',
  fieldSectionLabel: 'Cards',
  customListColumns: {},

  formFields: {
    'card:repInquiries': card('card:repInquiries', 1, 'Rep inquiries', 'Portal access requests, with the outstanding ones broken out. Needs repApproval:write.'),
    'card:userDataGaps': card('card:userDataGaps', 2, 'User data gaps', 'Users missing a role or a linked QB sales rep. Needs user:read.'),
    'card:repStats': card('card:repStats', 3, 'Your quotes and orders', 'Counts and totals for the viewer\'s own records. Own-scoped roles only.'),
    'card:yearlyOrderTotal': card('card:yearlyOrderTotal', 4, 'Order total this year', 'Company-wide. Needs order:read at All records.'),
    'card:revenueBacklog': card('card:revenueBacklog', 5, 'Revenue backlog', 'Company-wide. Needs order:read at All records.'),
    'card:receivables': card('card:receivables', 6, 'Receivables', 'Company-wide AR. Needs invoice:read at All records.'),
    'card:orderAlerts': card('card:orderAlerts', 7, 'Order alerts', 'Not shipped / open sales orders. Needs order:read at All records.'),
  },
  entityFields: {},
  validation: {},
});
