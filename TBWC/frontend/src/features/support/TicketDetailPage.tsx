import React, { useEffect, useState } from 'react';
import { TicketDetailPage as SharedTicketDetailPage, type AssignableUser } from '@meterit/framework-frontend/support';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { useAuth } from '../../hooks/useAuth';
import { supportTicketService } from './supportTicketsStore';
import { useUsers } from '../users/usersStore';

export const TicketDetailPage: React.FC = () => {
  const { checkPermission } = useAuth();
  const isAdminSupport = checkPermission('support:write');
  const { items: users, fetchItems } = useUsers();
  const [assignableUsers, setAssignableUsers] = useState<AssignableUser[]>([]);

  // Only admins can assign tickets (support:write), and only admins have
  // user:read — fetching otherwise would just 403.
  useEffect(() => {
    if (isAdminSupport) fetchItems({ limit: 1000 });
  }, [isAdminSupport]);

  useEffect(() => {
    setAssignableUsers(
      users.map((u: any) => ({ id: u.id, name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || u.id }))
    );
  }, [users]);

  return (
    <SharedTicketDetailPage
      ticketService={supportTicketService}
      isAdminSupport={isAdminSupport}
      basePath="/support"
      assignableUsers={assignableUsers}
      renderDocuments={(ticketId) => (
        <DocumentsGrid
          entityType="support_ticket"
          entityId={ticketId}
          api={documentsApi}
          storage={documentsStorage}
          classifyDocType={classifyDocTypeForFile}
        />
      )}
    />
  );
};

export default TicketDetailPage;
