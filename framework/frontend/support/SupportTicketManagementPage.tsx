import React from 'react';
import { Box } from '@mui/material';
import { EntityManagementPage } from '../components/entity';
import { SupportTicketList } from './SupportTicketList';
import type { SupportTicketListProps } from './SupportTicketList';
import { SupportTicketForm } from './SupportTicketForm';
import { SupportAnalyticsSummary } from './SupportAnalyticsSummary';
import type { SupportTicket, SupportTicketService } from './types';

export interface SupportTicketManagementPageProps extends Pick<SupportTicketListProps, 'useStore' | 'isAdminSupport' | 'showClientColumn'> {
  ticketService: SupportTicketService;
  /** Renders the Documents tab's content (the app wires its own DocumentsGrid instance). Omit to hide the tab. */
  renderDocuments?: (ticketId: number) => React.ReactNode;
}

/**
 * List + modal-form page for Support Tickets, using the same
 * EntityManagementPage + BaseForm shape as every other module (Orders,
 * Invoices, Quotes) - see TBWC/frontend/src/features/orders/OrderManagementPage.tsx.
 * Replaces the old hand-rolled create Dialog + separate /support/:id route.
 */
export const SupportTicketManagementPage: React.FC<SupportTicketManagementPageProps> = ({
  useStore, isAdminSupport, showClientColumn, ticketService, renderDocuments,
}) => {
  return (
    <Box p={3}>
      {isAdminSupport && <SupportAnalyticsSummary ticketService={ticketService} />}
      <EntityManagementPage<SupportTicket>
        title="Support Ticket"
        moduleIcon="support"
        modalSize="lg"
        schemaName="support_ticket"
        // Always shown, not isAdminSupport-gated like OrderManagementPage's
        // blanket admin-only writes — a non-admin filer still needs Save to
        // submit a NEW ticket (support:read is enough for POST). Editing an
        // EXISTING ticket as non-admin is the one case Save can't actually do
        // anything for; SupportTicketForm disables every field then, so
        // there's nothing to submit (see its isDisabled computation).
        showSaveButton
        editLabel={isAdminSupport ? undefined : 'View Ticket'}
        renderList={({ onEdit, onCreate }) => (
          <SupportTicketList useStore={useStore} isAdminSupport={isAdminSupport} showClientColumn={showClientColumn} onCreate={() => onCreate()} onTicketEdit={onEdit} />
        )}
        renderForm={({ entity, onCancel }) => (
          <SupportTicketForm
            ticket={entity}
            useStore={useStore}
            ticketService={ticketService}
            isAdminSupport={isAdminSupport}
            onCancel={onCancel}
            renderDocuments={renderDocuments}
          />
        )}
      />
    </Box>
  );
};

export default SupportTicketManagementPage;
