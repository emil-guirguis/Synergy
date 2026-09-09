import React from 'react';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { useInventoryEnhanced } from './inventoryStore';
import type { Inventory } from '../../types/inventory';

interface InventoryFormProps {
  item?: Inventory;
  onCancel: () => void;
  loading?: boolean;
}

/** Schema-driven inventory form (GET /api/schema/inventory); store handles create/update. */
export const InventoryForm: React.FC<InventoryFormProps> = ({ item, onCancel, loading = false }) => {
  const inventory = useInventoryEnhanced();

  return (
    <BaseForm
      schemaName="inventory"
      entity={item}
      store={inventory}
      onCancel={onCancel}
      className="inventory-form"
      loading={loading}
      showTabs={true}
      // `documents` is a UI-only field (no dbField) — the grid saves its own rows.
      fieldsToClean={['id', 'documents']}
      renderCustomField={(fieldName) => {
        if (fieldName === 'documents') {
          return (
            <DocumentsGrid
              entityType="inventory"
              entityId={item?.id}
              api={documentsApi}
              storage={documentsStorage}
            />
          );
        }
        return null;
      }}
    />
  );
};

export default InventoryForm;
