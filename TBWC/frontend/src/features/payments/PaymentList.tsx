import React, { useMemo } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { usePayments } from './paymentStore';
import { useAuth } from '../../hooks/useAuth';
import type { Payment } from '../../types/payment';

interface PaymentListProps {
  onPaymentView?: (payment: Payment) => void;
}

/** Read-only QuickBooks payment (AR) list. No create/edit/delete — qb_payment is synced from QB. */
export const PaymentList: React.FC<PaymentListProps> = ({ onPaymentView }) => {
  const auth = useAuth();
  const { schema } = useSchema('payment');

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Payment>(schema.formFields, {
      fieldOrder: ['ref_number', 'customer_name', 'txn_date', 'total_amount', 'unapplied_amount'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<Payment, any>({
    entityName: 'payment',
    entityNamePlural: 'payments',
    useStore: usePayments,
    features: {
      allowCreate: false,
      allowEdit: false,
      allowDelete: false,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    columns,
    filters,
    authContext: auth,
  });

  return (
    <div className="payment-list">
      <BaseList
        title="Payments"
        filters={baseList.renderFilters()}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No payments found. Run a QuickBooks sync to pull payments."
        onView={onPaymentView}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
    </div>
  );
};

export default PaymentList;
