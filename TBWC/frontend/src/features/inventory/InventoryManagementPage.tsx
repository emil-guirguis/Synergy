import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { InventoryList } from './InventoryList';
import { InventoryForm } from './InventoryForm';
import { searchPeople, shareRecord } from '../../services/shareService';
import { inventoryShareUrl, inventoryShareTitle } from './inventoryShare';
import type { Inventory } from '../../types/inventory';

export const InventoryManagementPage: React.FC = () => (
  <EntityManagementPage<Inventory>
    title="Inventory"
    moduleIcon="inventory"
    modalSize="xl"
    renderList={({ onEdit, onCreate }) => (
      <InventoryList onInventoryEdit={onEdit} onInventoryCreate={onCreate} />
    )}
    renderForm={({ entity, onCancel }) => <InventoryForm item={entity} onCancel={onCancel} />}
    shareUrl={inventoryShareUrl}
    shareTitle={inventoryShareTitle}
    searchPeople={searchPeople}
    onShare={({ recipient, note, url, title }) => shareRecord({ recipientUserId: recipient.id, title, linkUrl: url, note })}
  />
);

export default InventoryManagementPage;
