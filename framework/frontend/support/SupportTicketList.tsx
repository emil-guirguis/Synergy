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
    return generateColumnsFromSchema<SupportTicket>(schema.formFields, { fieldOrder, responsive: 'hide-mobile' });
  }, [schema, isAdminSupport, showClientColumn]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields, {
      fieldOrder: ['status', 'priority', 'type'],
    });
  }, [schema]);

  const baseList = useBaseList<SupportTicket, ReturnType<typeof useStore>>({
    entityName: 'support_ticket',
    entityNamePlural: 'support tickets',
    useStore,
    features: {
      allowCreate: true,
      allowEdit: false,
      allowDelete: false,
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
    <BaseList
      title="Support Tickets"
      filters={baseList.renderFilters()}
      onCreateClick={onCreate}
      data={baseList.data}
      columns={baseList.columns}
      loading={baseList.loading}
      error={baseList.error}
      emptyMessage="No tickets found."
      onRowClick={(ticket) => navigate(`${basePath}/${ticket.support_ticket_id}`)}
      pagination={baseList.pagination}
    />
  );
};

export default SupportTicketList;
