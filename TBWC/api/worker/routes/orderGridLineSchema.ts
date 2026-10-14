// ===== ORDER > LINE ITEMS grid (qb_sales_order.lines jsonb) =====
// Served at GET /api/schema/orderGridLine. Read-only child-row grid: lines are
// QuickBooks-synced into the order's own `lines` jsonb column (parent.field),
// not a table, so the only action is `read` — orders.ts drops `lines` without
// orderGridLine:read and redacts each line by that grant's hidden fields
// (Settings > Roles > Order > Line Items > Columns), e.g. reps' Rate/Amount
// (migration 097 moved those off order:read's old `lines[].rate` keys).
// Placeholder (hold-for-release) orders still edit lines through the order
// form's own Save (order:write) — a jsonb array can't be saved per row.
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const orderGridLineSchema = defineSchema({
  entityName: 'Order Line',
  tableName: 'qb_sales_order',
  description: 'Sales order line items (QuickBooks)',
  customListColumns: {},
  parent: { entity: 'order', field: 'lines', label: 'Line Items', actions: ['read'] },

  formFields: {
    item: field({ name: 'item', order: 1, type: FieldTypes.STRING, default: null, readOnly: true, label: 'Item', showOn: ['list', 'form'] }),
    desc: field({ name: 'desc', order: 2, type: FieldTypes.TEXTAREA, default: null, readOnly: true, label: 'Description', showOn: ['list', 'form'] }),
    quantity: field({ name: 'quantity', order: 3, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Qty', showOn: ['list', 'form'] }),
    rate: field({ name: 'rate', order: 4, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Rate', showOn: ['list', 'form'] }),
    amount: field({ name: 'amount', order: 5, type: FieldTypes.CURRENCY, default: null, readOnly: true, label: 'Amount', showOn: ['list', 'form'] }),
  },
  entityFields: {},
  validation: {},
});
