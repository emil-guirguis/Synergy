import React, { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useInvoices } from './invoiceStore';
import { useAuth } from '../../hooks/useAuth';
import type { Invoice } from '../../types/invoice';

interface InvoiceListProps {
  onInvoiceView?: (invoice: Invoice) => void;
}

/** Read-only QuickBooks invoice list. No create/edit/delete — qb_invoice is synced from QB. */
export const InvoiceList: React.FC<InvoiceListProps> = ({ onInvoiceView }) => {
  const auth = useAuth();
  const { schema } = useSchema('invoice');
  const [searchParams, setSearchParams] = useSearchParams();
  const invoicesHook = useInvoices();

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Invoice>(schema.formFields, {
      fieldOrder: ['ref_number', 'customer_name', 'txn_date', 'due_date', 'total', 'balance_remaining', 'is_paid'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<Invoice, any>({
    entityName: 'invoice',
    entityNamePlural: 'invoices',
    useStore: useInvoices,
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

  // AI chat search results link here with ?openId=<qb_invoice_id> to open a
  // specific invoice's form directly (see features/ai/AiChatPage.tsx) — fetch
  // that one record (not necessarily on the current page/filter) and open it
  // the same way a row click does, then drop the param so it doesn't reopen
  // on every future visit to this page.
  useEffect(() => {
    const openId = searchParams.get('openId');
    if (!openId || !onInvoiceView) return;
    invoicesHook
      .fetchItem(openId)
      .then((entity) => entity && onInvoiceView(entity as unknown as Invoice))
      .catch((err) => console.error('[InvoiceList] Failed to open invoice from AI chat link:', err));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('openId');
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="invoice-list">
      <BaseList
        title="Invoices"
        filters={baseList.renderFilters()}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No invoices found. Run a QuickBooks sync to pull invoices."
        onView={onInvoiceView}
        pagination={baseList.pagination}
      />
    </div>
  );
};

export default InvoiceList;
