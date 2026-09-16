import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { PaymentList } from './PaymentList';
import { PaymentForm } from './PaymentForm';
import type { Payment } from '../../types/payment';

/** QuickBooks Payments (AR) — read-only viewer + detail form. No edit/save (source of truth is QB). */
export const PaymentManagementPage: React.FC = () => (
  <EntityManagementPage<Payment>
    title="Payment"
    moduleIcon="payments"
    modalSize="lg"
    showSaveButton={false}
    editLabel={(entity) => `Payment ${entity.ref_number ?? ''}`.trim()}
    renderList={({ onEdit }) => <PaymentList onPaymentView={onEdit} />}
    renderForm={({ entity, onCancel }) => <PaymentForm payment={entity} onCancel={onCancel} />}
  />
);

export default PaymentManagementPage;
