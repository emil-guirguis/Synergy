// ===== QUOTE LINE schema (tbwc-site public.quote_line, migration 072) =====
// Served at GET /api/schema/quoteGridLine. PK is `quote_line_id`.
// Child-row schema (`parent`): edited one row at a time in the Line Items
// grid inside the quote form, saved per row through
// /api/quotes/:id/lines[/:lineId] (routes/quotes.ts → framework childRows.ts).
// Registered in permissions.ts's CHILD_SCHEMAS under the key `quoteGridLine`, so
// quoteGridLine:read/create/write/delete exist without being hand-listed and the
// roles tree shows it as Quote ▸ Line Items.
import {
  defineSchema,
  field,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const quoteGridLineSchema = defineSchema({
  entityName: 'Line Item',
  tableName: 'quote_line',
  idFieldName: 'quote_line_id',
  description: 'TBWC quote line item',
  customListColumns: {},
  defaultSortBy: 'line_order asc',
  parent: { entity: 'quote', foreignKey: 'quote_id', label: 'Line Items', orderField: 'line_order' },

  formFields: {
    // Picked from the catalog (valueField = qb_item's real PK). item_name is
    // the label column the grid shows; the route re-reads it from qb_item on
    // every pick rather than trusting the client's copy.
    qb_item_id: field({
      name: 'qb_item_id', order: 1, type: FieldTypes.SELECT, default: null, required: false,
      label: 'Item', dbField: 'qb_item_id', showOn: ['list', 'form'],
      referenceSearch: { endpoint: '/inventory', valueField: 'qb_item_id', labelField: 'full_name', displayField: 'item_name' },
    }),
    description: field({ name: 'description', order: 2, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'Description', dbField: 'description', showOn: ['list', 'form'] }),
    // Whole units only (step 1) — enforced by routes/quotes.ts too.
    quantity: field({ name: 'quantity', order: 3, type: FieldTypes.NUMBER, default: 1, required: false, label: 'Qty', dbField: 'quantity', min: 0, step: 1, showOn: ['list', 'form'] }),
    rate: field({ name: 'rate', order: 4, type: FieldTypes.CURRENCY, default: 0, required: false, label: 'Rate', dbField: 'rate', showOn: ['list', 'form'] }),
    // Extended price: always quantity * rate, computed server-side (routes/quotes.ts).
    amount: field({ name: 'amount', order: 5, type: FieldTypes.CURRENCY, default: 0, required: false, readOnly: true, label: 'Extended', dbField: 'amount', showOn: ['list', 'form'] }),
  },

  entityFields: {
    quote_line_id: field({ name: 'quote_line_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'quote_line_id' }),
    item_name: field({ name: 'item_name', type: FieldTypes.STRING, default: null, readOnly: true, label: 'Item Name', dbField: 'item_name' }),
  },
  validation: {},
});
