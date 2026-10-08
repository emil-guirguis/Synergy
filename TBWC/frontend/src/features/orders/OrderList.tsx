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
import { renderCurrencyCell, renderChipList, type ChipItem } from '@meterit/framework-frontend/components/list/utils/renderHelpers';
import { ShareMenu, useShareTarget } from '@meterit/framework-frontend/components/share';
import { searchPeople, shareRecord } from '../../services/shareService';
import { orderShareUrl, orderShareTitle } from './orderShare';
import { EmailOrderDialog } from './EmailOrderDialog';
import { Box, IconButton, Tooltip } from '@mui/material';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import { useOrdersEnhanced } from './ordersStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Order } from '../../types/order';

// Rule set is TBWC-specific (order fields); the chip rendering itself
// (renderChipList) lives in the framework so other modules/projects can
// reuse the same multi-badge-per-cell pattern for their own conditions.
function getOrderStatusChips(order: Order): ChipItem[] {
  const chips: ChipItem[] = [];

  // TBWC-only placeholder, never sent to QuickBooks (migration 069) — shown
  // here instead of its own list column so "Statuses" stays the one place to
  // scan for anything noteworthy about an order.
  if (order.order_type === 'hold_for_release') {
    chips.push({
      label: 'Hold for Release',
      variant: 'primary',
      title: 'TBWC-only placeholder order — editable in full, never sent to QuickBooks.',
    });
  } else if (order.order_type === 'consignment') {
    chips.push({
      label: 'Consignment',
      variant: 'primary',
      title: 'TBWC-only placeholder order — editable in full, never sent to QuickBooks.',
    });
  }

  // invoice_status is QB-driven (see orderInvoiceStatus.ts) — 'Not Invoiced'
  // is its true default/open state, distinct from Partially Invoiced/Closed/
  // Paid, all of which also have no *full* invoice but aren't actually open.
  // "Not Invoiced" itself only applies once it's actually shipped (actual_ship_date,
  // TBWC's manually-entered field) — unbilled AND unshipped is the complementary
  // "Open Sales Order" dashboard case (orders.ts's CHIP_CONDITIONS.openSalesOrder),
  // not this chip.
  if (order.invoice_status === 'Not Invoiced' && order.actual_ship_date) {
    chips.push({
      label: 'Not Invoiced',
      variant: 'warning',
      title: 'Shipped, but no invoice created yet.',
    });
  } else if (order.invoice_status === 'Closed') {
    chips.push({
      label: 'Closed',
      variant: 'neutral',
      title: 'Manually closed in QuickBooks — no further invoicing expected.',
    });
  }

  // Financials tab never filled in — any of its three core fields missing counts.
  // Overage excluded on purpose — it's legitimately left blank often.
  if (order.sold_for == null || order.commission == null || order.d_net_cost == null) {
    chips.push({
      label: 'Missing Financials',
      variant: 'warning',
      title: 'Sold For, D Net Cost, or Commission has not been entered on the Financials tab.',
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

// Static legend — the per-row chips above only ever show the ones that
// apply to THAT order, so a row with none of these conditions shows no chip
// at all and someone scanning the grid has no way to learn what's possible
// ("Closed"? "Hold for Release"?) without asking. One explanation here,
// mirroring each chip's own `title` text, beats hunting for an example row.
const STATUS_LEGEND: { label: string; description: string }[] = [
  { label: 'Hold for Release', description: 'TBWC-only placeholder order — editable in full, never sent to QuickBooks.' },
  { label: 'Consignment', description: 'TBWC-only placeholder order — editable in full, never sent to QuickBooks.' },
  { label: 'Not Invoiced', description: 'Shipped, but no invoice created yet.' },
  { label: 'Closed', description: 'Manually closed in QuickBooks — no further invoicing expected.' },
  { label: 'Missing Financials', description: 'Sold For, D Net Cost, or Commission has not been entered on the Financials tab.' },
  { label: 'Not Shipped', description: 'Ship NLT date has passed and Ship Date has not been entered yet.' },
];

function StatusColumnInfo() {
  return (
    <Tooltip
      title={
        <Box sx={{ p: 0.5 }}>
          {STATUS_LEGEND.map((s) => (
            <Box key={s.label} sx={{ mb: 0.75, fontSize: '0.8rem' }}>
              <Box component="span" sx={{ fontWeight: 700 }}>{s.label}</Box>
              {' — '}{s.description}
            </Box>
          ))}
          <Box sx={{ mt: 0.75, fontSize: '0.8rem', fontStyle: 'italic' }}>
            "Open Sales Order" (the dashboard card) isn't one of these chips — it's Not Invoiced orders with no Ship Date yet.
          </Box>
        </Box>
      }
    >
      <IconButton
        size="small"
        onClick={(e) => e.stopPropagation()}
        aria-label="What each status means"
        sx={{ ml: 0.5, p: 0.25 }}
      >
        <InfoOutlinedIcon fontSize="inherit" />
      </IconButton>
    </Tooltip>
  );
}

const STATUS_CHIPS_COLUMN: ColumnDefinition<Order> = {
  key: 'status_chips',
  label: 'Statuses',
  headerExtra: <StatusColumnInfo />,
  responsive: 'always-show',
  render: (_value, row) => renderChipList(getOrderStatusChips(row)),
};

// Keys mirror CHIP_CONDITIONS in api/worker/routes/orders.ts — the backend
// reproduces getOrderStatusChips' predicates so filtering happens before
// pagination rather than only hiding/showing rows already on the current page.
const CHIP_OPTIONS: { value: string; label: string }[] = [
  { value: 'notInvoiced', label: 'Not Invoiced' },
  { value: 'closed', label: 'Closed' },
  { value: 'notShipped', label: 'Not Shipped' },
  { value: 'missingFinancials', label: 'Missing Financials' },
  { value: 'holdForRelease', label: 'Hold for Release' },
  { value: 'consignment', label: 'Consignment' },
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

const NEW_ORDER_TYPES: { value: 'hold_for_release' | 'consignment'; label: string }[] = [
  { value: 'hold_for_release', label: 'Hold for Release' },
  { value: 'consignment', label: 'Consignment' },
];

/** Toolbar "New ▾" split button — picks which TBWC-only placeholder type
 *  (orders.ts's PLACEHOLDER_TYPES) the opened form defaults to. `order: 3`
 *  (higher than the fw toolbar's default-0 items) places it after the Filter
 *  toggle button, matching the fw's own title/filter/export/New layout —
 *  BaseList itself has no onCreateClick slot for a dropdown, only a plain
 *  click handler, so this renders through toolbarContent instead. */
function NewOrderButton({ onCreate }: { onCreate: (initial?: Partial<Order>) => void }) {
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

  const pick = (orderType: 'hold_for_release' | 'consignment') => {
    setOpen(false);
    onCreate({
      order_type: orderType,
      // Pre-filled, not just defaulted server-side on save — so it's visibly
      // set the moment the form opens (see routes/orders.ts's POST / for the
      // same default as a fallback, not a cross-check).
      txn_date: new Date().toISOString().slice(0, 10),
    });
  };

  return (
    <div style={{ position: 'relative', order: 3 }} ref={rootRef}>
      <button
        type="button"
        className="base-list__toolbar-btn base-list__toolbar-btn--new"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Create a TBWC-only placeholder order, editable in full, that is never sent to QuickBooks"
      >
        New
        <i className="material-symbols-outlined">arrow_drop_down</i>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            right: 0,
            zIndex: 10,
            minWidth: 180,
            // Same blue as the trigger button (base-list__toolbar-btn--new),
            // not the default white dropdown panel.
            background: '#2563eb',
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
            overflow: 'hidden',
          }}
        >
          {NEW_ORDER_TYPES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitem"
              onClick={() => pick(t.value)}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#1d4ed8'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              style={{
                display: 'block',
                width: '100%',
                padding: '0.5rem 0.875rem',
                border: 'none',
                background: 'transparent',
                color: '#ffffff',
                textAlign: 'left',
                cursor: 'pointer',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              {t.label}
            </button>
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
  onOrderCreate?: (initial?: Partial<Order>) => void;
  authContext?: { checkPermission: (p: any) => boolean; user: any; scopeOf?: (p: string) => 'all' | 'own' | null };
}

export const OrderList: React.FC<OrderListProps> = ({ onOrderEdit, onOrderCreate, authContext: authProp }) => {
  const realAuth = useAuth();
  const auth = authProp ?? realAuth;
  const { schema } = useSchema('order');
  const [searchParams, setSearchParams] = useSearchParams();
  const [emailOrderId, setEmailOrderId] = useState<number | null>(null);

  // Mirrors the server's own scope check (orders.ts ownOnly()) rather than
  // hardcoding is_admin, so an order:read=all role grant (e.g. a rep who should
  // see everyone's orders) actually widens the rep dropdown + list, not just the
  // backend query.
  const canSeeAll = auth.scopeOf?.('order:read') === 'all';
  // Hold for Release is an admin-only affordance (same bar as the 'jay'/
  // 'service' flags) — no reason to check a dedicated permission for a
  // button no rep role is granted order:write to use anyway.
  const isAdmin = !!auth.user?.is_admin;
  // A rep who manages other reps (public.user_manager) still has order:read
  // scope 'own', but the server's IN-list for "own" already covers every
  // managed rep too (orders.ts visibleRepListIds) — so this list can show
  // several different reps' orders even though canSeeAll is false. Without
  // this, the rep field order hides the Sales Rep column and the filter
  // effect below force-locks the dropdown to just the caller's own rep,
  // hiding their managed reps' orders from view.
  const managedRepListIds: string[] = auth.user?.managed_sales_rep_list_ids ?? [];
  const isManagingReps = managedRepListIds.length > 0;

  // Rep list view is a deliberately trimmed-down field set (per rep request) —
  // distinct from the admin view, which keeps the fuller QB-derived columns.
  // Build notes are internal-to-TBWC: dropped from the rep list here and from
  // the rep form by the Notes tab's visibleFor: ['admin'] (see orderSchema.ts).
  // Order money is admin-only too — no total here, and OrderLinesGrid drops the
  // rate/amount columns and the totals footer for the same reason.
  // No shipped_date here: QB's own ship-by date is an internal scheduling date,
  // so reps see only actual_ship_date (the date it really shipped).
  // A managing rep sees orders across several reps, so they need the Sales
  // Rep column to tell them apart — a plain rep (list always 1 rep: themselves)
  // doesn't.
  const REP_FIELD_ORDER = isManagingReps
    ? ['customer_name', 'job_name', 'sales_rep', 'ref_number', 'txn_date', 'actual_ship_date', 'po_number', 'expedite']
    : ['customer_name', 'job_name', 'ref_number', 'txn_date', 'actual_ship_date', 'po_number', 'expedite'];
  const REP_LABEL_OVERRIDES: Partial<Record<keyof Order, string>> = {
    ref_number: 'TBWC #',
    txn_date: 'Received',
  };

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<Order>(schema.formFields, {
      fieldOrder: canSeeAll
        ? ['customer_name', 'build_notes', 'ref_number', 'txn_date', 'ship_no_later_than', 'actual_ship_date', 'po_number', 'job_name', 'sales_rep', 'total', 'is_fully_invoiced', 'shipped_date', 'expedite', 'service']
        : REP_FIELD_ORDER,
      responsive: 'hide-mobile',
    });
    // order_type isn't its own column — a hold_for_release order gets a
    // "Hold for Release" chip in the Statuses column instead (see
    // getOrderStatusChips), so drop the raw column the schema's showOn:
    // ['list'] would otherwise add. Its Type filter stays (generated
    // separately off the same schema field), which is still a reasonable way
    // to look up every hold-for-release order. invoice_number is dropped too —
    // never populated for a hold-for-release row, and otherwise redundant with
    // the Statuses column's "Not Invoiced" chip and the Invoiced filter.
    const visible = (canSeeAll ? cols : cols.filter((col) => REP_FIELD_ORDER.includes(col.key as string)))
      .filter((col) => col.key !== 'order_type' && col.key !== 'invoice_number');
    // Admin-only: the chip rules read shipped_date, which is QB's internal
    // ship-by scheduling field — reps only ever see actual_ship_date (see
    // REP_FIELD_ORDER comment above), so don't derive a rep-facing status
    // off a field they're deliberately not shown.
    if (canSeeAll) {
      const poIdx = visible.findIndex((col) => col.key === 'po_number');
      visible.splice(poIdx === -1 ? 0 : poIdx + 1, 0, STATUS_CHIPS_COLUMN);
    }
    // Email PDF — admin/employee only (matches order:write; see orders.ts's
    // POST /:id/email, same restriction as the AI chat email_order tool).
    if (isAdmin) {
      visible.push({
        key: 'email_action',
        label: '',
        sortable: false,
        responsive: 'always-show',
        render: (_value, row) => (
          <Tooltip title="Email order">
            <IconButton
              size="small"
              onClick={(e) => {
                e.stopPropagation();
                setEmailOrderId(row.qb_sales_order_id);
              }}
            >
              <EmailOutlinedIcon fontSize="inherit" />
            </IconButton>
          </Tooltip>
        ),
      });
    }
    for (const col of visible) {
      if (CHECKBOX_COLUMNS.has(col.key as keyof Order)) {
        col.render = (_value, row) => renderCheckbox(row[col.key as keyof Order] as boolean | null);
      }
      // total comes back from Postgres as a numeric string — renderCurrencyCell coerces.
      if (col.key === 'total') {
        col.render = (_value, row) => renderCurrencyCell(row.total as any);
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
  }, [schema, canSeeAll, isManagingReps, isAdmin]);
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
    const repField = schema.entityFields?.sales_rep_list_id;

    if (!canSeeAll) {
      // Reps only get filters for the columns they can actually see — otherwise
      // hidden fields (build notes, invoice #) come back as filter boxes.
      const repFilters = schemaFilters.filter((f) => REP_FIELD_ORDER.includes(f.key as string));
      if (isManagingReps) {
        // Managing rep: a real dropdown, scoped to the reps they actually
        // manage (+ themselves) rather than the full admin rep list — the
        // server's own IN-list (orders.ts) only ever returns orders for
        // that same set, so a wider picker would just offer options that
        // always come back empty.
        const labels = repField?.enumLabels || {};
        const ids = [...new Set([ownRepListId, ...managedRepListIds].filter(Boolean) as string[])];
        repFilters.push({
          key: 'sales_rep_list_id',
          label: 'Sales Rep',
          type: 'select',
          options: ids.map((id) => ({ label: labels[id] || (id === ownRepListId ? ownRepLabel : id) || id, value: id })),
          placeholder: 'All My Reps',
        });
      } else if (ownRepListId) {
        // Plain rep view: no picker, just a locked display of who this data belongs to.
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
  }, [schema, canSeeAll, isManagingReps, managedRepListIds, ownRepListId, ownRepLabel]);

  const { shareTarget, openShare, closeShare } = useShareTarget();

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
      // checkPermission resolves this against the real order:write grant
      // (admin + employee, 'all' — migrations 039/040; rep/customer have
      // none). canUpdate below decides the row affordance, not whether the
      // row opens at all — a rep still opens it, read-only (see OrderForm).
      update: Permission.ORDER_UPDATE,
      delete: Permission.ORDER_DELETE,
    },
    columns,
    filters,
    onEdit: onOrderEdit,
    onCreate: onOrderCreate,
    authContext: auth,
  });

  // Dashboard alert cards link here with ?missingPo=true / ?notShipped=true /
  // ?invoice_status=Not Invoiced — apply them as filters (server-side, via
  // orders.ts's IS NULL / column checks) rather than a visible filter control,
  // since they're a synthetic drill-down, not a declared schema field. Gated
  // on `schema` being loaded: useBaseList's own initial-fetch bookkeeping (the
  // "hasActiveFilter" effect vs. the [filters] watcher's first-run skip)
  // assumes filters are still empty the first time schema finishes loading —
  // setting a filter before that race resolves gets silently swallowed by
  // both effects and no fetch ever fires.
  useEffect(() => {
    if (!schema) return;
    if (searchParams.get('missingPo') === 'true') baseList.setFilter('missingPo', 'true');
    if (searchParams.get('notShipped') === 'true') baseList.setFilter('notShipped', 'true');
    if (searchParams.get('invoice_status')) baseList.setFilter('invoice_status', searchParams.get('invoice_status'));
    if (searchParams.get('excludePackingSlip') === 'true') baseList.setFilter('excludePackingSlip', 'true');
    // Statuses chip filter — e.g. the dashboard's "Open Sales Orders" card
    // links to ?chips=openSalesOrder.
    if (searchParams.get('chips')) baseList.setFilter('chips', searchParams.get('chips')!.split(','));
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
  // the select is disabled, but "Clear Filters" isn't. A managing rep's
  // filter is a real enabled dropdown (see filters above), so it's exempt:
  // locking it to their own rep would hide their managed reps' orders.
  useEffect(() => {
    if (!canSeeAll && !isManagingReps && ownRepListId && baseList.filters.sales_rep_list_id !== ownRepListId) {
      baseList.setFilter('sales_rep_list_id', ownRepListId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeAll, isManagingReps, ownRepListId, baseList.filters.sales_rep_list_id]);

  return (
    <div className="order-list">
      <BaseList
        title="Orders"
        toolbarContent={
          isAdmin && onOrderCreate ? <NewOrderButton onCreate={onOrderCreate} /> : undefined
        }
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
        // the row affordance — a pencil titled "Edit" for whoever holds
        // order:write, an eye titled "View" for everyone else, whose form is
        // read-only (OrderForm itself still enforces that; this is just the icon).
        onEdit={baseList.canUpdate ? baseList.handleEdit : undefined}
        onView={!baseList.canUpdate ? baseList.handleView : undefined}
        onShare={(order) => openShare({ url: orderShareUrl(order), title: orderShareTitle(order) })}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
      {shareTarget && (
        <ShareMenu
          open={!!shareTarget}
          onClose={closeShare}
          title={shareTarget.title}
          url={shareTarget.url}
          searchPeople={searchPeople}
          onShare={({ recipient, note }) =>
            shareRecord({ recipientUserId: recipient.id, title: shareTarget.title, linkUrl: shareTarget.url, note })
          }
        />
      )}
      {emailOrderId !== null && (
        <EmailOrderDialog open={emailOrderId !== null} onClose={() => setEmailOrderId(null)} orderId={emailOrderId} />
      )}
    </div>
  );
};

export default OrderList;
