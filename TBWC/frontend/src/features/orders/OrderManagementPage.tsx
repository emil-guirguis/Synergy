import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { OrderList } from './OrderList';
import { OrderForm } from './OrderForm';
import { useAuth } from '../../hooks/useAuth';
import { searchPeople, shareRecord } from '../../services/shareService';
import { orderShareUrl, orderShareTitle } from './orderShare';
import type { Order } from '../../types/order';

export const OrderManagementPage: React.FC = () => {
  const { scopeOf } = useAuth();
  // PUT /api/orders/:id is requirePermission('order:write'): without that
  // grant the form is a viewer, so drop the Save button rather than show one
  // that can only 403, and title the modal "View Order". Keyed off the grant,
  // not is_admin — the Employee role holds order:write and was being shown a
  // read-only form.
  const canWrite = scopeOf('order:write') !== null;
  // The SO# belongs in the header for everyone, not just editors. A static
  // editLabel string is what dropped it (EntityManagementPage derives
  // "Edit Order <ref_number>" from the schema's titleField only when no
  // editLabel is given), so the viewer label is a function over the row
  // instead. ref_number is never hidden from a role that can open the order
  // at all, but fall back to the bare verb if it somehow arrives empty.
  return (
    <EntityManagementPage<Order>
      title="Order"
      moduleIcon="orders"
      modalSize="xl"
      schemaName="order"
      showSaveButton={canWrite}
      editLabel={canWrite ? undefined : (o) => (o?.ref_number ? `View Order ${o.ref_number}` : 'View Order')}
      renderList={({ onEdit, onCreate }) => (
        <OrderList onOrderEdit={onEdit} onOrderCreate={onCreate} />
      )}
      renderForm={({ entity, onCancel }) => <OrderForm order={entity} onCancel={onCancel} />}
      shareUrl={orderShareUrl}
      shareTitle={orderShareTitle}
      searchPeople={searchPeople}
      onShare={({ recipient, note, url, title }) => shareRecord({ recipientUserId: recipient.id, title, linkUrl: url, note })}
    />
  );
};

export default OrderManagementPage;
