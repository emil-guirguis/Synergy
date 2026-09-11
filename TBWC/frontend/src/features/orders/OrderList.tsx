import React, { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { renderNumberCell } from '@meterit/framework-frontend/components/list/utils/renderHelpers';
import CheckBoxIcon from '@mui/icons-material/CheckBox';
import CheckBoxOutlineBlankIcon from '@mui/icons-material/CheckBoxOutlineBlank';
import { useOrdersEnhanced } from './ordersStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Order } from '../../types/order';

// Schema's default boolean-column render is a Yes/No pill; the order list wants
// a literal checkbox glyph instead for these two flag columns.
const CHECKBOX_COLUMNS = new Set<keyof Order>(['is_fully_invoiced', 'expedite']);

function renderCheckbox(value: boolean | null | undefined) {
  return value
    ? React.createElement(CheckBoxIcon, { fontSize: 'small', color: 'action' })
    : React.createElement(CheckBoxOutlineBlankIcon, { fontSize: 'small', color: 'disabled' });
}

interface OrderListProps {
  onOrderEdit?: (order: Order) => void;
  onOrderCreate?: () => void;
  authContext?: { checkPermission: (p: any) => boolean; user: any };
}

export const OrderList: React.FC<OrderListProps> = ({ onOrderEdit, onOrderCreate, authContext: authProp }) => {
  const realAuth = useAuth();
  const auth = authProp ?? realAuth;
  const { schema } = useSchema('order');
  const [searchParams, setSearchParams] = useSearchParams();

  // A rep only ever sees their own orders (server-scoped to rep_id = them), so
  // the QB rep dropdown has nothing meaningful to filter — lock it to their own
  // linked rep instead of leaving a picker that can't actually change anything.
  const canSeeAll = auth.user?.is_admin;

  // Rep list view is a deliberately trimmed-down field set (per rep request) —
  // distinct from the admin view, which keeps the fuller QB-derived columns.
  // Build notes are internal-to-TBWC: dropped from the rep list here and from
  // the rep form by the Notes tab's visibleFor: ['admin'] (see orderSchema.ts).
  // Order money is admin-only too — no total here, and OrderLinesGrid drops the
  // rate/amount columns and the totals footer for the same reason.
  const REP_FIELD_ORDER = ['customer_name', 'job_name', 'ref_number', 'po_number', 'txn_date', 'shipped_date', 'expedite'];
  const REP_LABEL_OVERRIDES: Partial<Record<keyof Order, string>> = {
    ref_number: 'TBWC #',
    txn_date: 'Received',
    shipped_date: 'Ship Date',
  };

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<Order>(schema.formFields, {
      fieldOrder: canSeeAll
        ? ['customer_name', 'build_notes', 'ref_number', 'po_number', 'job_name', 'sales_rep', 'total', 'is_fully_invoiced', 'invoice_number', 'txn_date', 'ship_no_later_than', 'shipped_date', 'expedite']
        : REP_FIELD_ORDER,
      responsive: 'hide-mobile',
    });
    const visible = canSeeAll ? cols : cols.filter((col) => REP_FIELD_ORDER.includes(col.key as string));
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
        filters={baseList.renderFilters()}
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
