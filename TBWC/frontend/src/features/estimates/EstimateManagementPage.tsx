import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { EstimateList } from './EstimateList';
import { EstimateForm } from './EstimateForm';
import { useAuth } from '../../hooks/useAuth';
import type { Estimate } from '../../types/estimate';

export const EstimateManagementPage: React.FC = () => {
  const { isAdmin } = useAuth();
  // Reps open estimates read-only (PUT /api/estimates/:id is estimate:write,
  // which reps don't have — migration 056), so drop the Save button rather
  // than show one that can only 403, and title the modal "View Estimate" —
  // nothing in it is editable for them. Same pattern as OrderManagementPage.
  return (
    <EntityManagementPage<Estimate>
      title="Estimate"
      moduleIcon="estimates"
      modalSize="lg"
      schemaName="estimate"
      showSaveButton={isAdmin}
      editLabel={isAdmin ? undefined : 'View Estimate'}
      renderList={({ onEdit, onCreate }) => <EstimateList onEstimateEdit={onEdit} onEstimateCreate={onCreate} />}
      renderForm={({ entity, onCancel }) => <EstimateForm estimate={entity} onCancel={onCancel} />}
    />
  );
};

export default EstimateManagementPage;
