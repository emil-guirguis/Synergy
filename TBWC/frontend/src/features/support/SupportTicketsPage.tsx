import React from 'react';
import { SupportTicketManagementPage as SharedSupportTicketManagementPage } from '@meterit/framework-frontend/support';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { useAuth } from '../../hooks/useAuth';
import { useSupportTicketsEnhanced, supportTicketService } from './supportTicketsStore';

export const SupportTicketsPage: React.FC = () => {
  const { checkPermission } = useAuth();
  return (
    <SharedSupportTicketManagementPage
      useStore={useSupportTicketsEnhanced}
      ticketService={supportTicketService}
      isAdminSupport={checkPermission('support:write')}
      renderDocuments={(ticketId) => (
        <DocumentsGrid
          entityType="support_ticket"
          entityId={ticketId}
          api={documentsApi}
          storage={documentsStorage}
          classifyDocType={classifyDocTypeForFile}
          // Columns/roles node from supportGridDocument. Actions stay open:
          // documents.ts also lets a ticket's own filer attach to it without
          // the grid grant, which this page can't tell from the ticket id.
          schemaName="supportGridDocument"
        />
      )}
    />
  );
};

export default SupportTicketsPage;
