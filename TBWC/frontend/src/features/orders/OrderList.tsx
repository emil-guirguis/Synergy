import React, { useEffect, useMemo } from 'react';
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

  const columns = useMemo(() => {
    if (!schema) return [];
    const cols = generateColumnsFromSchema<Order>(schema.formFields, {
      fieldOrder: ['customer_name', 'ref_number', 'po_number', 'sales_rep', 'invoice_number', 'total', 'is_fully_invoiced', 'txn_date', 'ship_no_later_than', 'shipped_date', 'expedite'],
      responsive: 'hide-mobile',
    });
    for (const col of cols) {
      if (CHECKBOX_COLUMNS.has(col.key as keyof Order)) {
        col.render = (_value, row) => renderCheckbox(row[col.key as keyof Order] as boolean | null);
      }
      // total comes back from Postgres as a numeric string — coerce before formatting.
      if (col.key === 'total') {
        col.render = (_value, row) => renderNumberCell(Number(row.total), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      }
    }
    return cols;
  }, [schema]);

  // A rep only ever sees their own orders (server-scoped to rep_id = them), so
  // the QB rep dropdown has nothing meaningful to filter — lock it to their own
  // linked rep instead of leaving a picker that can't actually change anything.
  const canSeeAll = auth.user?.is_admin || auth.user?.can_see_orders;
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
      // Rep view: no picker, just a locked display of who this data belongs to.
      if (ownRepListId) {
        schemaFilters.push({
          key: 'sales_rep_list_id',
          label: 'Sales Rep',
          type: 'select',
          options: [{ label: ownRepLabel || 'Me', value: ownRepListId }],
          disabled: true,
        });
      }
      return schemaFilters;
    }

    const repField = schema.entityFields?.sales_rep_list_id;
    if (repField?.enumValues?.length) {
      const labels = repField.enumLabels || {};
      schemaFilters.push({
        key: 'sales_rep_list_id',
        label: 'Sales Rep',
        type: 'select',
        options: [
          { label: 'All Reps', value: '' },
          ...repField.enumValues.map((v: string) => ({ label: labels[v] || v, value: v })),
        ],
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
      allowStats: false,
    },
    permissions: {
      create: Permission.ORDER_CREATE,
      update: Permission.ORDER_UPDATE,
      delete: Permission.ORDER_DELETE,
    },
    columns,
    filters,
    onEdit: onOrderEdit,
    onCreate: onOrderCreate,
    authContext: auth,
  });

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
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No orders found."
        onEdit={baseList.handleEdit}
        pagination={baseList.pagination}
      />
    </div>
  );
};

export default OrderList;
