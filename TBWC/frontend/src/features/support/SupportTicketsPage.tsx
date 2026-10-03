import React from 'react';
import { SupportTicketsPage as SharedSupportTicketsPage } from '@meterit/framework-frontend/support';
import { useAuth } from '../../hooks/useAuth';
import { useSupportTicketsEnhanced, supportTicketService } from './supportTicketsStore';

export const SupportTicketsPage: React.FC = () => {
  const { checkPermission } = useAuth();
  return (
    <SharedSupportTicketsPage
      useStore={useSupportTicketsEnhanced}
      ticketService={supportTicketService}
      isAdminSupport={checkPermission('support:write')}
      basePath="/support"
    />
  );
};

export default SupportTicketsPage;
