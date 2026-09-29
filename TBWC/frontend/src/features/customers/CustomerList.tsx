import React, { useMemo } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useCustomers } from './customerStore';
import { useAuth } from '../../hooks/useAuth';
import type { Customer } from '../../types/customer';

/** Read-only QuickBooks customer list. No create/edit/delete — qb_customer is synced from QB. */
export const CustomerList: React.FC = () => {
  const auth = useAuth();
  const { schema } = useSchema('customer');

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Customer>(schema.formFields, {
      fieldOrder: ['full_name', 'company_name', 'phone', 'email', 'balance', 'is_active'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<Customer, any>({
    entityName: 'customer',
    entityNamePlural: 'customers',
    useStore: useCustomers,
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
    <div className="customer-list">
      <BaseList
        title="Customers"
        filters={baseList.renderFilters()}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No customers found. Run a QuickBooks sync to pull customers."
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
    </div>
  );
};

export default CustomerList;
