import React from 'react';
import { SupportTicketManagementPage as SharedSupportTicketsPage } from '@meterit/framework-frontend/support';
import { useSupportTicketsEnhanced, supportTicketService } from '../supportTicketsStore';
import { useAuth } from '../../hooks/useAuth';

const SupportTicketsPage: React.FC = () => {
  const { user } = useAuth();
  return (
    <SharedSupportTicketsPage
      useStore={useSupportTicketsEnhanced}
      ticketService={supportTicketService}
      isAdminSupport={user?.is_support_admin === true}
      showClientColumn
    />
  );
};

export default SupportTicketsPage;
