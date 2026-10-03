import React from 'react';
import { TicketDetailPage as SharedTicketDetailPage } from '@meterit/framework-frontend/support';
import { useAuth } from '../../hooks/useAuth';
import { supportTicketService } from './supportTicketsStore';

export const TicketDetailPage: React.FC = () => {
  const { checkPermission } = useAuth();
  return (
    <SharedTicketDetailPage
      ticketService={supportTicketService}
      isAdminSupport={checkPermission('support:write')}
      basePath="/support"
    />
  );
};

export default TicketDetailPage;
