import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import type { ColumnDefinition } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { renderNumberCell, renderChipList, type ChipItem } from '@meterit/framework-frontend/components/list/utils/renderHelpers';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import { useOrdersEnhanced } from './ordersStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Order } from '../../types/order';

// Rule set is TBWC-specific (order fields); the chip rendering itself
// (renderChipList) lives in the framework so other modules/projects can
// reuse the same multi-badge-per-cell pattern for their own conditions.
function getOrderStatusChips(order: Order): ChipItem[] {
  const chips: ChipItem[] = [];

  // Ship Date (actual_ship_date) entered but no invoice number yet.
  if (order.actual_ship_date && !order.invoice_number) {
    chips.push({
      label: 'Not Invoiced',
      variant: 'warning',
      title: 'Ship Date is set but no Invoices created yet.',
    });
  }

  // Ship NLT date passed and Ship Date still not filled in.
  if (!order.actual_ship_date) {
    // Date-only string compare (YYYY-MM-DD prefix) — avoids TZ drift from
    // constructing Date objects just to compare calendar days.
    const today = new Date().toISOString().slice(0, 10);
    const nlt = order.ship_no_later_than?.slice(0, 10);
    if (nlt && nlt < today) {
      chips.push({
        label: 'Not Shipped',
        variant: 'error',
        title: 'Ship NLT date has passed and Ship Date has not been entered yet.',
      });
    }
  }

  return chips;
}

const STATUS_CHIPS_COLUMN: ColumnDefinition<Order> = {
  key: 'status_chips',
  label: 'Status',
  responsive: 'always-show',
  render: (_value, row) => renderChipList(getOrderStatusChips(row)),
};

// Keys mirror CHIP_CONDITIONS in api/worker/routes/orders.ts — the backend
// reproduces getOrderStatusChips' predicates so filtering happens before
// pagination rather than only hiding/showing rows already on the current page.
const CHIP_OPTIONS: { value: string; label: string }[] = [
  { value: 'notInvoiced', label: 'Not Invoiced' },
  { value: 'notShipped', label: 'Not Shipped' },
];

/** Small checkbox-popover filter — show only orders carrying at least one of
 *  the checked Status chips ("All" — nothing checked — shows every order).
 *  Bespoke to this page rather than the schema-driven filter system: that
 *  system's select filters are single-value, and its declared 'multiselect'
 *  type has no renderer yet (see useBaseList.tsx renderFilters). */
function ChipFilter({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const toggle = (chip: string) => {
    onChange(value.includes(chip) ? value.filter((c) => c !== chip) : [...value, chip]);
  };

  const summary = value.length === 0
    ? 'All Status'
    : value.map((v) => CHIP_OPTIONS.find((o) => o.value === v)?.label || v).join(', ');

  return (
    <div className="list__filter-item" style={{ position: 'relative' }} ref={rootRef}>
      <button
        type="button"
        className="form-control"
        style={{ textAlign: 'left', cursor: 'pointer' }}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        {summary}
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 10,
            background: 'var(--color-surface, #fff)',
            border: '1px solid var(--color-border, #e0e0e0)',
            borderRadius: 6,
            padding: '0.5rem',
            minWidth: '100%',
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0', whiteSpace: 'nowrap', cursor: 'pointer' }}>
            <input type="checkbox" checked={value.length === 0} onChange={() => onChange([])} />
            All
          </label>
          {CHIP_OPTIONS.map((opt) => (
            <label key={opt.value} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.25rem 0', whiteSpace: 'nowrap', cursor: 'pointer' }}>
              <input type="checkbox" checked={value.includes(opt.value)} onChange={() => toggle(opt.value)} />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

// Schema's default boolean-column render is a Yes/No pill; the order list wants
// a literal checkbox glyph instead for these flag columns.
const CHECKBOX_COLUMNS = new Set<keyof Order>(['is_fully_invoiced', 'expedite', 'service']);

function renderCheckbox(value: boolean | null | undefined) {
  return value
    ? React.createElement(CheckBoxIcon, { fontSize: 'small', color: 'action' })
    : React.createElement(CheckBoxOutlineBlankIcon, { fontSize: 'small', color: 'disabled' });
}

interface OrderListProps {
  onOrderEdit?: (order: Order) => void;
  onOrderCreate?: () => void;
  authContext?: { checkPermission: (p: any) => boolean; user: any; scopeOf?: (p: string) => 'all' | 'own' | null };
}

export const OrderList: React.FC<OrderListProps> = ({ onOrderEdit, onOrderCreate, authContext: authProp }) => {
  const realAuth = useAuth();
  const auth = authProp ?? realAuth;
  const { schema } = useSchema('order');
  const [searchParams, setSearchParams] = useSearchParams();

  // Mirrors the server's own scope check (orders.ts ownOnly()) rather than
  // hardcoding is_admin, so an order:read=all role grant (e.g. a rep who should
  // see everyone's orders) actually widens the rep dropdown + list, not just the
  // backend query.
  const canSeeAll = auth.scopeOf?.('order:read') === 'all';

  // Rep list view is a deliberately trimmed-down field set (per rep request) —
  // distinct from the admin view, which keeps the fuller QB-derived columns.
  // Build notes are internal-to-TBWC: dropped from the rep list here and from
  // the rep form by the Notes tab's visibleFor: ['admin'] (see orderSchema.ts).
  // Order money is admin-only too — no total here, and OrderLinesGrid drops the
  // rate/amount columns and the totals footer for the same reason.
  // No shipped_date here: QB's own ship-by date is an internal scheduling date,
  // so reps see only actual_ship_date (the date it really shipped).
  const REP_FIELD_ORDER = ['customer_name', 'job_name', 'ref_number', 'txn_date', 'actual_ship_date', 'po_number', 'expedite'];
  const REP_LABEL_OVERRIDES: Partial<Record<keyof Order, string>> = {
    ref_number: 'TBWC #',
    txn_date: 'Received',
  };

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<Order>(schema.formFields, {
      fieldOrder: canSeeAll
        ? ['customer_name', 'build_notes', 'ref_number', 'txn_date', 'ship_no_later_than', 'actual_ship_date', 'po_number', 'job_name', 'sales_rep', 'total', 'is_fully_invoiced', 'invoice_number', 'shipped_date', 'expedite', 'service']
        : REP_FIELD_ORDER,
      responsive: 'hide-mobile',
    });
    const visible = canSeeAll ? cols : cols.filter((col) => REP_FIELD_ORDER.includes(col.key as string));
    // Admin-only: the chip rules read shipped_date, which is QB's internal
    // ship-by scheduling field — reps only ever see actual_ship_date (see
    // REP_FIELD_ORDER comment above), so don't derive a rep-facing status
    // off a field they're deliberately not shown.
    if (canSeeAll) {
      const poIdx = visible.findIndex((col) => col.key === 'po_number');
      visible.splice(poIdx === -1 ? 0 : poIdx + 1, 0, STATUS_CHIPS_COLUMN);
    }
    for (const col of visible) {
      if (CHECKBOX_COLUMNS.has(col.key as keyof Order)) {
        col.render = (_value, row) => renderCheckbox(row[col.key as keyof Order] as boolean | null);
      }
      // total comes back from Postgres as a numeric string — coerce before formatting.
      if (col.key === 'total') {
        col.render = (_value, row) => renderNumberCell(Number(row.total), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
      // Long free-text notes: wrap instead of forcing the table wider (auto
      // table layout otherwise stretches this column to fit it on one line).
      if (col.key === 'build_notes' || col.key === 'job_name') {
        col.className = 'data-table__cell--wrap';
        col.width = col.key === 'build_notes' ? '260px' : '160px';
      }
      if (!canSeeAll && REP_LABEL_OVERRIDES[col.key as keyof Order]) {
        col.label = REP_LABEL_OVERRIDES[col.key as keyof Order]!;
      }
    }
    return visible;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, canSeeAll]);
  const ownRepListId = auth.user?.sales_rep_list_id ?? null;
  const ownRepLabel = [auth.user?.sales_rep_initial, auth.user?.sales_rep_name].filter(Boolean).join(' - ')
    || auth.user?.sales_rep_name || '';

  const filters = useMemo(() => {
    if (!schema) return [];
    // 'sales_rep' displays the joined qb_sales_rep.name (see orders.ts), so a
    // free-text filter against it would search the raw synced Initial code
    // instead — drop the schema-generated one and filter on sales_rep_list_id
    // (a real column) via a proper rep dropdown instead.
    const schemaFilters = generateFiltersFromSchema(schema.formFields).filter((f) => f.key !== 'sales_rep');

    if (!canSeeAll) {
      // Reps only get filters for the columns they can actually see — otherwise
      // hidden fields (build notes, invoice #) come back as filter boxes.
      const repFilters = schemaFilters.filter((f) => REP_FIELD_ORDER.includes(f.key as string));
      // Rep view: no picker, just a locked display of who this data belongs to.
      if (ownRepListId) {
        repFilters.push({
          key: 'sales_rep_list_id',
          label: 'Sales Rep',
          type: 'select',
          options: [{ label: ownRepLabel || 'Me', value: ownRepListId }],
          disabled: true,
        });
      }
      return repFilters;
    }

    const repField = schema.entityFields?.sales_rep_list_id;
    if (repField?.enumValues?.length) {
      const labels = repField.enumLabels || {};
      schemaFilters.push({
        key: 'sales_rep_list_id',
        label: 'Sales Rep',
        type: 'select',
        // Don't include an "All" option here — renderFilters already prepends
        // one from `placeholder` (or `All ${label}`); adding it here too
        // rendered two blank "All ..." rows above the rep list.
        options: repField.enumValues.map((v: string) => ({ label: labels[v] || v, value: v })),
        placeholder: 'All Reps',
      });
    }
    return schemaFilters;
  }, [schema, canSeeAll, ownRepListId, ownRepLabel]);

  const baseList = useBaseList<Order, any>({
    entityName: 'order',
    entityNamePlural: 'orders',
    useStore: useOrdersEnhanced,
    // Orders exist only via the QuickBooks sync — edit-only (TBWC-owned fields).
    features: {
      allowCreate: false,
      allowEdit: true,
      allowDelete: false,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      filtersExpandedByDefault: true,
      allowStats: false,
    },
    permissions: {
      create: Permission.ORDER_CREATE,
      // AuthContext.checkPermission grants every permission to admins only, so
      // requiring ORDER_UPDATE here left canUpdate false for reps — useBaseList
      // then withheld onEdit entirely and a rep's row click did nothing. Reps
      // open the record read-only (see OrderForm), so gate the row on nothing
      // and let the form + the API decide what they may change.
      update: canSeeAll ? Permission.ORDER_UPDATE : undefined,
      delete: Permission.ORDER_DELETE,
    },
    columns,
    filters,
    onEdit: onOrderEdit,
    onCreate: onOrderCreate,
    authContext: auth,
  });

  // Dashboard alert cards link here with ?missingPo=true / ?notShipped=true —
  // apply them as filters (server-side, via orders.ts's IS NULL checks) rather
  // than a visible filter control, since they're a synthetic drill-down, not a
  // real column filter. The "not invoiced" card instead drives the real
  // is_fully_invoiced filter (?is_fully_invoiced=false) below, so the visible
  // "Invoiced" dropdown lands on "No" instead of silently filtering underneath
  // it. Gated on `schema` being loaded: useBaseList's own initial-fetch
  // bookkeeping (the "hasActiveFilter" effect vs. the [filters] watcher's
  // first-run skip) assumes filters are still empty the first time schema
  // finishes loading — setting a filter before that race resolves gets
  // silently swallowed by both effects and no fetch ever fires.
  useEffect(() => {
    if (!schema) return;
    if (searchParams.get('missingPo') === 'true') baseList.setFilter('missingPo', 'true');
    if (searchParams.get('notShipped') === 'true') baseList.setFilter('notShipped', 'true');
    if (searchParams.get('is_fully_invoiced') === 'false') baseList.setFilter('is_fully_invoiced', 'false');
    if (searchParams.get('excludeZeroTotal') === 'true') baseList.setFilter('excludeZeroTotal', 'true');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, searchParams]);

  // AI chat search results link here with ?openId=<qb_sales_order_id> to open
  // a specific order's form directly (see features/ai/AiChatPage.tsx) — fetch
  // that one record (not necessarily on the current page/filter) and open it
  // the same way a row click does, then drop the param so it doesn't reopen
  // on every future visit to this page.
  const ordersHook = useOrdersEnhanced();
  useEffect(() => {
    const openId = searchParams.get('openId');
    if (!openId || !onOrderEdit) return;
    ordersHook
      .fetchItem(openId)
      .then((entity) => entity && onOrderEdit(entity as unknown as Order))
      .catch((err) => console.error('[OrderList] Failed to open order from AI chat link:', err));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('openId');
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Keep the locked rep filter pinned even if something clears filters —
  // the select is disabled, but "Clear Filters" isn't.
  useEffect(() => {
    if (!canSeeAll && ownRepListId && baseList.filters.sales_rep_list_id !== ownRepListId) {
      baseList.setFilter('sales_rep_list_id', ownRepListId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeAll, ownRepListId, baseList.filters.sales_rep_list_id]);

  return (
    <div className="order-list">
      <BaseList
        title="Orders"
        filters={
          <>
            {baseList.renderFilters()}
            {canSeeAll && (
              <ChipFilter
                value={baseList.filters.chips || []}
                onChange={(next) => baseList.setFilter('chips', next)}
              />
            )}
          </>
        }
        defaultFiltersOpen={baseList.filtersExpandedByDefault}
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No orders found."
        // Same handler either way (it opens the modal); the prop chosen decides
        // the row affordance — a pencil titled "Edit" for admins, an eye titled
        // "View" for reps, whose form is read-only.
        onEdit={canSeeAll && baseList.canUpdate ? baseList.handleEdit : undefined}
        onView={!canSeeAll ? baseList.handleEdit : undefined}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
    </div>
  );
};

export default OrderList;
