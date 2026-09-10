// ===== ORDER schema (tbwc-site public.qb_sales_order) =====
// Served at GET /api/schema/order. PK is `qb_sales_order_id` (bigint identity).
// Backing table is the QB-synced staging table: QB-owned fields are readOnly
// (the next sync would clobber edits); TBWC-owned fields (build notes, expedite,
// deadlines, fees) are the editable ones and survive every re-sync.
// invoice_number / invoice_status are denormalised from qb_invoice via LinkedTxn
// (see orderInvoiceStatus.ts) so list filter/sort work as plain columns.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

export const orderSchema = defineSchema({
  entityName: 'Order',
  tableName: 'qb_sales_order',
  idFieldName: 'qb_sales_order_id',
  description: 'TBWC order (QuickBooks sales order + TBWC-owned fields)',
  formMaxWidth: '1300px',
  customListColumns: {},
  defaultSortBy: 'qb_sales_order_id desc',

  formTabs: [
    tab({
      name: 'Order',
      order: 1,
      // Two visual columns: the QB-synced Details fill the left half (spanning
      // both rows); the right half stacks Dates over the Expedite/Jay flags.
      // The trailing 1fr row absorbs Details' extra height so Flags sit
      // directly under Dates instead of being pushed down.
      columns: '1fr 1fr',
      rows: 'auto 1fr',
      sections: [
        section({
          name: 'Details',
          order: 1,
          gridColumn: '1',
          gridRow: '1 / 3',
          fields: [
            field({ name: 'customer_name', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'ref_number', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'SO #', description: 'Sales Order Number', dbField: 'ref_number', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'po_number', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'PO #', description: 'Purchase Order Number', dbField: 'po_number', maxLength: 100, showOn: ['list', 'form'] }),
            field({ name: 'job_name', order: 8, type: FieldTypes.STRING, default: '', required: false, label: 'Job Name', dbField: 'job_name', maxLength: 300, showOn: ['list', 'form'] }),
            field({ name: 'sales_rep', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep', maxLength: 200, showOn: ['list', 'form'] }),
            field({ name: 'invoice_number', order: 5, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Invoice #', dbField: 'invoice_number', maxLength: 100, showOn: ['list', 'form'] }),
            // Checkbox in the list per QB's own is_fully_invoiced flag; the finer-
            // grained invoice_status (Paid/Closed/etc) stays on the form only.
            field({ name: 'is_fully_invoiced', order: 6, type: FieldTypes.BOOLEAN, default: false, required: false, readOnly: true, label: 'Invoiced', dbField: 'is_fully_invoiced', showOn: ['list', 'form'] }),
            field({ name: 'invoice_status', order: 7, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Invoice Status', dbField: 'invoice_status', maxLength: 100, showOn: ['form'], enumValues: ['Not Invoiced', 'Partially Invoiced', 'Invoiced', 'Paid', 'Closed'] }),
            // No QB source (checked, see migration 014/020) — manually entered,
            // TBWC-owned like build_notes; survives every re-sync.
          ],
        }),
        section({
          name: 'Dates',
          order: 2,
          gridColumn: '2',
          gridRow: '1',
          fields: [
            field({ name: 'txn_date', order: 1, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Order Date', dbField: 'txn_date', showOn: ['list', 'form'] }),
            field({ name: 'due_date', order: 2, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Due Date', dbField: 'due_date', showOn: ['form'] }),
            field({ name: 'ship_no_later_than', order: 3, type: FieldTypes.DATE, default: null, required: false, label: 'Ship NLT', description: 'Ship No Later Than', dbField: 'ship_no_later_than', showOn: ['list', 'form'] }),
            // QB's own SalesOrderRet ShipDate — synced, not manually entered.
            field({ name: 'shipped_date', order: 4, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Shipped Date', dbField: 'shipped_date', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Flags',
          order: 3,
          gridColumn: '2',
          gridRow: '2',
          fields: [
            field({ name: 'expedite', order: 1, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Expedite', dbField: 'expedite', showOn: ['list', 'form'] }),
            // Internal TBWC flag — admin-only, same variant filter as the
            // admin-only tabs below (OrderForm passes 'admin' vs 'rep').
            field({ name: 'jay', order: 2, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Jay', dbField: 'jay', showOn: ['form'], visibleFor: ['admin'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Shipping',
      order: 2,
      // Reps get a trimmed order form: only this general Order tab and the QB
      // line items. Everything else (addresses, money, notes, documents) is
      // admin-only -- OrderForm passes variant='admin' for admins, 'rep' otherwise.
      visibleFor: ['admin'],
      // QB's "TBWC Sales Order" template layout: addresses on the left,
      // shipping/tax details stacked on the right.
      columns: '1fr 1fr',
      sections: [
        section({
          name: 'Addresses',
          order: 1,
          gridColumn: '1',
          fields: [
            field({ name: 'bill_address_block', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, readOnly: true, label: 'Name / Address', dbField: 'bill_address_block', maxLength: 500, showOn: ['form'] }),
            field({ name: 'ship_address_block', order: 2, type: FieldTypes.TEXTAREA, default: '', required: false, readOnly: true, label: 'Ship To', dbField: 'ship_address_block', maxLength: 500, showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Shipping Details',
          order: 2,
          gridColumn: '2',
          fields: [
            // QB's own Terms field, but this company's terms list holds
            // freight-handling codes (e.g. "PPC") rather than payment terms —
            // the template itself labels this box "Freight Terms".
            field({ name: 'freight_terms', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Freight Terms', dbField: 'freight_terms', maxLength: 100, showOn: ['form'] }),
            field({ name: 'ship_via', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Ship Via', dbField: 'ship_via', maxLength: 100, showOn: ['form'] }),
            // QB's CustomerMsgRef, repurposed by this company as the order's
            // contact line ("Name / email / phone").
            field({ name: 'contact', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Contact', dbField: 'contact', maxLength: 300, showOn: ['form'] }),
            field({ name: 'customer_tax_code', order: 4, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer Tax Code', dbField: 'customer_tax_code', maxLength: 100, showOn: ['form'] }),
            // No dbField — UI-only trigger, rendered by OrderForm's
            // renderCustomField as a "Packing List" button (opens a printable
            // packing slip built from this order's own fields/lines).
            field({ name: 'packing_list', order: 5, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Line Items',
      order: 3,
      sections: [
        section({
          name: 'Line Items',
          order: 1,
          fields: [
            // No dbField write-back (QB-owned, sync-only) — rendered by
            // OrderForm's renderCustomField as a read-only EditableDataGrid.
            field({ name: 'lines', order: 1, type: FieldTypes.OBJECT, default: null, dbField: 'lines', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Financials',
      order: 4,
      visibleFor: ['admin'],
      // Costs on the left, fees/commission on the right.
      columns: '1fr 1fr',
      sections: [
        section({
          name: 'Costs',
          order: 1,
          gridColumn: '1',
          fields: [
            field({ name: 'total', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Order Total', dbField: 'total', showOn: ['list', 'form'] }),
            // The price the order was actually sold at — distinct from QB's own
            // `total` and from `d_net_cost`; the commission calculator computes
            // off this figure, not off either of those.
            field({ name: 'sold_for', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, label: 'Sold For', dbField: 'sold_for', showOn: ['form'] }),
            field({ name: 'd_net_cost', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, label: 'D-Net Cost', dbField: 'd_net_cost', showOn: ['form'] }),
            field({ name: 'overage', order: 4, type: FieldTypes.CURRENCY, default: null, required: false, label: 'Overage', dbField: 'overage', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Fees & Commission',
          order: 2,
          gridColumn: '2',
          fields: [
            field({ name: 'commission', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, label: 'Commission', dbField: 'commission', showOn: ['form'] }),
            field({ name: 'project_admin_fee', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, label: 'Project Administration Fee', dbField: 'project_admin_fee', showOn: ['form'] }),
            // Postgres GENERATED column (commission + overage) — the DB itself
            // rejects direct writes, so this is readOnly here to match.
            field({ name: 'commission_total', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Commission Total', dbField: 'commission_total', showOn: ['list','form'] }),
            field({ name: 'trade_ally_fee', order: 4, type: FieldTypes.CURRENCY, default: null, required: false, label: 'Trade Ally Fee', dbField: 'trade_ally_fee', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Notes',
      order: 5,
      visibleFor: ['admin'],
      sections: [
        section({
          name: 'Notes',
          order: 1,
          fields: [
            field({ name: 'build_notes', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'Build Notes', dbField: 'build_notes', maxLength: 5000, showOn: ['list', 'form'], rows: 3 }),
            // General free-text notes, distinct from build_notes above.
            field({ name: 'notes', order: 2, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'Order Notes', dbField: 'notes', maxLength: 5000, showOn: ['form'], rows: 3 }),
            // Editable — a save queues it for push to QB via SalesOrderModRq
            // (see orders.ts's PUSHABLE + migration 023's qbwc_push_queue) rather
            // than writing this column directly, since QB is the source of truth
            // and the next full pull would otherwise clobber it. The GET response
            // shows the queued value in the meantime (falls back to the last-synced
            // value once it lands) — same field throughout, no separate "pending" one.
            field({ name: 'memo', order: 3, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'QB Memo', dbField: 'memo', maxLength: 4095, showOn: ['form'], rows: 3 }),
            // Not memo-specific — this is qb_sales_order.time_modified, refreshed
            // whenever QB confirms ANY change to the record (a memo push included).
            // Doubles as "did my memo edit land yet?": if it's still older than
            // when you saved, the push hasn't gone through (QBWC hasn't run yet).
            field({ name: 'time_modified', order: 4, type: FieldTypes.DATETIME, default: null, required: false, readOnly: true, label: 'QB Last Synced', dbField: 'time_modified', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 6,
      visibleFor: ['admin'],
      sections: [
        section({
          name: 'Documents',
          order: 1,
          fields: [
            // No dbField — UI-only anchor. TBWC's OrderForm renders the shared
            // framework DocumentsGrid here; rows live in public.document keyed by
            // (entity_type='order', entity_id=<record id>), saved on edit, not
            // with this form.
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_sales_order_id: field({ name: 'qb_sales_order_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_sales_order_id' }),
    txn_id: field({ name: 'txn_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'QB Txn ID', dbField: 'txn_id' }),
    rep_id: field({ name: 'rep_id', type: FieldTypes.STRING, default: null, readOnly: true, label: 'Rep ID', dbField: 'rep_id' }),
    // Not list/form-shown — exists only as an options carrier for the order
    // list's rep filter. enumValues/enumLabels are injected at serve time from
    // public.qb_sales_rep (see schema route), keyed by list_id since that's
    // what this column stores (the QB SalesRepRef ListID).
    sales_rep_list_id: field({ name: 'sales_rep_list_id', type: FieldTypes.SELECT, default: null, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep_list_id', enumValues: [] }),
    is_manually_closed: field({ name: 'is_manually_closed', type: FieldTypes.BOOLEAN, default: null, readOnly: true, label: 'Manually Closed', dbField: 'is_manually_closed' }),
  },
  validation: {},
});
