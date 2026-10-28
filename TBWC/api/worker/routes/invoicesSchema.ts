// ===== INVOICE schema (tbwc-site public.qb_invoice) =====
// Served at GET /api/schema/invoice. PK is `qb_invoice_id` (bigint identity).
// Mostly read-only: qb_invoice is a QuickBooks staging mirror (pulled via
// InvoiceQueryRq), so every QB-sourced field is readOnly and the module offers
// no create/delete. The one exception is the AR tab (migration 118) —
// TBWC-owned collection-tracking columns the sync never touches, editable by a
// caller holding invoice:write. routes/invoices.ts's WRITABLE allowlist is what
// actually enforces that split; readOnly here only shapes the form.
import {
  defineSchema,
  field,
  tab,
  section,
  FieldTypes,
} from '@meterit/framework-backend/api/base/SchemaDefinition';

/**
 * How a collection notice was sent. Lives here rather than as a DB CHECK so
 * adding "letter" later is a code change, not another migration — and
 * routes/invoices.ts imports this same list to validate a PUT, so the form's
 * dropdown and the server's guard can never drift apart.
 */
export const NOTICE_METHODS = ['email', 'phone'] as const;
export const NOTICE_METHOD_LABELS: Record<string, string> = { email: 'Email', phone: 'Phone' };

export const invoicesSchema = defineSchema({
  entityName: 'Invoice',
  tableName: 'qb_invoice',
  idFieldName: 'qb_invoice_id',
  description: 'QuickBooks invoices (synced QB → TBWC, read-only)',
  formMaxWidth: '900px',
  customListColumns: {},
  defaultSortBy: 'txn_date desc',

  formTabs: [
    tab({
      name: 'Invoice',
      order: 1,
      sections: [
        section({
          name: 'Identity',
          order: 1,
          fields: [
            field({ name: 'ref_number', order: 1, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Invoice #', dbField: 'ref_number', maxLength: 50, showOn: ['list', 'form'] }),
            field({ name: 'customer_name', order: 2, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Customer', dbField: 'customer_name', maxLength: 500, showOn: ['list', 'form'] }),
            // Not a qb_invoice column — joined from public.qb_sales_rep via
            // sales_rep_list_id (see invoices.ts's findAll/findById joins).
            field({ name: 'sales_rep', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: true, label: 'Sales Rep', dbField: 'sales_rep', maxLength: 200, showOn: ['list', 'form'] }),
            field({ name: 'txn_date', order: 4, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Invoice Date', dbField: 'txn_date', showOn: ['list', 'form'] }),
            field({ name: 'due_date', order: 5, type: FieldTypes.DATE, default: null, required: false, readOnly: true, label: 'Due Date', dbField: 'due_date', showOn: ['list', 'form'] }),
          ],
        }),
        section({
          name: 'Totals',
          order: 2,
          fields: [
            field({ name: 'subtotal', order: 1, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Subtotal', dbField: 'subtotal', showOn: ['form'] }),
            field({ name: 'total', order: 2, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Total', dbField: 'total', showOn: ['list', 'form'] }),
            field({ name: 'balance_remaining', order: 3, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Balance', dbField: 'balance_remaining', showOn: ['list', 'form'] }),
            field({ name: 'is_paid', order: 4, type: FieldTypes.BOOLEAN, default: false, required: false, readOnly: true, label: 'Paid', dbField: 'is_paid', showOn: ['list', 'form'] }),
            // Not qb_invoice columns — computed per row in invoices.ts (see
            // DAYS_PAST_DUE there), and NULL unless the invoice still owes money
            // past its due date, so both cells read blank on an invoice that is
            // paid or not yet due rather than showing a misleading 0.
            //
            // Form only. Aging belongs to the AR Aging report, which shows it
            // per row in its own table; on the Invoices list it was noise next
            // to Balance and Due Date. invoices.ts still accepts
            // ?days_past_due / ?days_past_due_max as inclusive bounds (no
            // visible control generates them any more, but a link can).
            field({ name: 'days_past_due', order: 5, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'Days Past Due', dbField: 'days_past_due', showOn: ['form'] }),
            field({ name: 'total_past_due', order: 6, type: FieldTypes.CURRENCY, default: null, required: false, readOnly: true, label: 'Total Past Due', dbField: 'total_past_due', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    // AR collections tracking — the only writable tab (migration 118). Sits
    // right after the invoice itself because it's the tab anyone chasing money
    // actually works in; Line Items and Documents are reference material.
    tab({
      name: 'AR',
      order: 2,
      // Explicit 3-column grid rather than the section-count heuristic: the
      // five sections would otherwise sit in one cramped row, clipping the
      // date inputs. Row 1 is Payment History (2 cols) beside Collections (1
      // col) — both are a glance at the account, not data entry, so they
      // share a row rather than each claiming one of their own. Row 2 is the
      // three notices, one column apiece and the order the work happens in.
      // The AR note spans the full width below everything.
      columns: 3,
      sections: [
        section({
          name: 'Customer Payment History',
          order: 1,
          gridColumn: '1 / 3',
          fields: [
            // Not a column and not from QuickBooks: QB's Customer Center shows
            // an "Average Days to Pay" that qbXML never sends (CustomerQueryRq
            // returns no such field — checked against every synced customer),
            // so invoices.ts derives it per customer from qb_payment.applied_to
            // at read time. Detail only: it's one aggregate query per record,
            // and the list has no room for a figure that's about the customer
            // rather than the invoice.
            field({ name: 'avg_days_to_pay', order: 1, type: FieldTypes.NUMBER, default: null, required: false, readOnly: true, label: 'Avg Days to Pay (derived)', dbField: 'avg_days_to_pay', showOn: ['form'] }),
          ],
        }),
        section({
          name: 'Collections',
          order: 2,
          // No gridColumn: Payment History just claimed columns 1-2, so this
          // falls into the one cell left in row 1 (column 3) on its own.
          fields: [
            // Reaches the list too (and, being a boolean, gets a Yes/No filter
            // there for free) — unlike the notice methods and notes, whether a
            // late fee went on is something you want to scan a whole page of
            // past-due invoices for.
            field({ name: 'late_fee_applied', order: 1, type: FieldTypes.BOOLEAN, default: false, required: false, label: 'Late Fee Applied', dbField: 'late_fee_applied', showOn: ['list', 'form'] }),
          ],
        }),
        ...[1, 2, 3].map((n) =>
          section({
            name: `${n}${['st', 'nd', 'rd'][n - 1]} Notice`,
            order: n + 2,
            fields: [
              // Form only, like the method and note beside it: the notice
              // dates are collections working data, and the AR Aging report's
              // table is where they're read across invoices.
              field({ name: `notice_${n}_date`, order: 1, type: FieldTypes.DATE, default: null, required: false, label: 'Date', dbField: `notice_${n}_date`, showOn: ['form'] }),
              field({ name: `notice_${n}_method`, order: 2, type: FieldTypes.SELECT, default: null, required: false, label: 'Method', dbField: `notice_${n}_method`, enumValues: [...NOTICE_METHODS], enumLabels: NOTICE_METHOD_LABELS, showOn: ['form'] }),
              field({ name: `notice_${n}_note`, order: 3, type: FieldTypes.STRING, default: '', required: false, label: 'Note', dbField: `notice_${n}_note`, maxLength: 1000, showOn: ['form'] }),
            ],
          })
        ),
        section({
          name: 'Notes',
          order: 6,
          gridColumn: '1 / -1',
          fields: [
            field({ name: 'ar_notes', order: 1, type: FieldTypes.TEXTAREA, default: '', required: false, label: 'AR Notes', dbField: 'ar_notes', showOn: ['form'] }),
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
          // OrderLinesGrid (title="Line Items") draws its own header — bare avoids a duplicate.
          bare: true,
          fields: [
            field({ name: 'lines', order: 1, type: FieldTypes.JSON, default: null, required: false, readOnly: true, label: 'Lines', dbField: 'lines', showOn: ['form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Documents',
      order: 4,
      sections: [
        section({
          name: 'Documents',
          order: 1,
          // DocumentsGrid draws its own title+Add/Folder header — bare avoids a duplicate.
          bare: true,
          fields: [
            // No dbField — UI-only anchor. TBWC's InvoiceForm renders the shared
            // framework DocumentsGrid here; rows live in public.document keyed by
            // (entity_type='invoice', entity_id=<record id>), saved on edit, not
            // with this form.
            field({ name: 'documents', order: 1, type: FieldTypes.OBJECT, default: null, showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    qb_invoice_id: field({ name: 'qb_invoice_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'qb_invoice_id' }),
  },
  validation: {},
});
