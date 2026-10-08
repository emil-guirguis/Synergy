import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { BaseList } from '../components/list/BaseList';
import { useBaseList } from '../components/list/hooks';
import { useSchema } from '../components/form/utils/schemaLoader';
import { generateColumnsFromSchema, generateFiltersFromSchema } from '../components/list/utils/schemaColumnGenerator';
import type { SupportTicket, SupportTicketsStore } from './types';

const allowedAuth = { checkPermission: () => true as boolean, user: undefined };

export interface SupportTicketListProps {
  useStore: () => SupportTicketsStore;
  /** Whether the caller manages tickets across every client (true) or only sees their own (false). */
  isAdminSupport: boolean;
  /** Multi-tenant apps show which client org filed each ticket; single-tenant apps have none, so default this off. */
  showClientColumn?: boolean;
  /** Route prefix a ticket row navigates to (`${basePath}/${support_ticket_id}`). */
  basePath?: string;
  onCreate?: () => void;
}

export const SupportTicketList: React.FC<SupportTicketListProps> = ({
  useStore, isAdminSupport, showClientColumn = false, basePath = '/support/tickets', onCreate,
}) => {
  const navigate = useNavigate();
  const { schema } = useSchema('support_ticket');

  const columns = useMemo(() => {
    if (!schema) return [];
    const fieldOrder = isAdminSupport
      ? ['title', ...(showClientColumn ? ['client_tenant_name'] : []), 'type', 'status', 'priority', 'assigned_to_name', 'created_at']
      : ['title', 'type', 'status', 'priority', 'created_at'];
    const cols = generateColumnsFromSchema<SupportTicket>(schema.formFields, { fieldOrder, responsive: 'hide-mobile' });
    // generateColumnsFromSchema uses fieldOrder only to sort — every
    // showOn:['list'] schema field still gets a column regardless, so
    // admin-only fields (assigned_to_name, client_tenant_name) need an
    // explicit filter too, same pattern as OrderList.tsx's REP_FIELD_ORDER.
    return cols.filter((col) => fieldOrder.includes(col.key as string));
  }, [schema, isAdminSupport, showClientColumn]);

  const filters = useMemo(() => {
    if (!schema) return [];
    // Exclude assigned_to_name/created_by_name: they're joined display
    // columns (routes/support.ts), not real support_ticket columns, so a
    // free-text filter on them would try to query a nonexistent column.
    const { assigned_to_name, created_by_name, client_tenant_name, ...filterableFields } = schema.formFields;
    return generateFiltersFromSchema(filterableFields, {
      fieldOrder: ['status', 'priority', 'type'],
    });
  }, [schema]);

  const baseList = useBaseList<SupportTicket, ReturnType<typeof useStore>>({
    entityName: 'support_ticket',
    entityNamePlural: 'support tickets',
    useStore,
    features: {
      allowCreate: true,
      // Edit/delete both go through PUT/DELETE /api/support/:id, which are
      // support:write (admin-only) server-side — gating the buttons on
      // isAdminSupport here just keeps a non-admin from seeing a button that
      // would 403 anyway. No `permissions` object needed: these booleans are
      // the only gate authContext's always-true checkPermission stub doesn't
      // already short-circuit past (see hooks.ts's canEdit/canDelete).
      allowEdit: isAdminSupport,
      allowDelete: isAdminSupport,
      allowBulkActions: false,
      allowExport: false,
      allowSearch: true,
      allowFilters: true,
    },
    columns,
    filters,
    onEdit: (ticket) => navigate(`${basePath}/${ticket.support_ticket_id}`),
    onCreate,
    authContext: allowedAuth,
  });

  return (
    <>
      <BaseList
        title="Support Tickets"
        filters={baseList.renderFilters()}
        onCreateClick={onCreate}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No tickets found."
        onEdit={baseList.canUpdate ? baseList.handleEdit : undefined}
        onDelete={baseList.canDelete ? baseList.handleDelete : undefined}
        onRowClick={(ticket) => navigate(`${basePath}/${ticket.support_ticket_id}`)}
        pagination={baseList.pagination}
      />
      {baseList.renderDeleteConfirmation()}
    </>
  );
};

export default SupportTicketList;
