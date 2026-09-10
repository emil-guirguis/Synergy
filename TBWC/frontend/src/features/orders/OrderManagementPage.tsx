import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { OrderList } from './OrderList';
import { OrderForm } from './OrderForm';
import { useAuth } from '../../hooks/useAuth';
import type { Order } from '../../types/order';

export const OrderManagementPage: React.FC = () => {
  const { isAdmin } = useAuth();
  // Reps open orders read-only (PUT /api/orders/:id is admin-only), so drop the
  // Save button rather than show one that can only 403, and title the modal
  // "View Order" — nothing in it is editable for them.
  return (
    <EntityManagementPage<Order>
      title="Order"
      moduleIcon="orders"
      modalSize="xl"
      showSaveButton={isAdmin}
      editLabel={isAdmin ? undefined : 'View Order'}
      renderList={({ onEdit, onCreate }) => (
        <OrderList onOrderEdit={onEdit} onOrderCreate={onCreate} />
      )}
      renderForm={({ entity, onCancel }) => <OrderForm order={entity} onCancel={onCancel} />}
    />
  );
};

export default OrderManagementPage;
