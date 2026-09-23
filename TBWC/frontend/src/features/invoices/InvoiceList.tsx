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
      fieldOrder: ['ref_number', 'customer_name', 'sales_rep', 'txn_date', 'due_date', 'total', 'balance_remaining', 'is_paid'],
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
      allowExport: true,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    columns,
    filters,
    authContext: auth,
  });

  // Dashboard's Receivables card links here with ?is_paid=false — apply it as
  // the real is_paid filter (same field the visible dropdown drives) rather
  // than a synthetic one, so the drill-down and manual filtering land on the
  // same control. Gated on `schema` loaded, same race as OrderList's
  // equivalent effect (see there for why).
  useEffect(() => {
    if (!schema) return;
    if (searchParams.get('is_paid') === 'false') baseList.setFilter('is_paid', 'false');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, searchParams]);

  // Invoice Totals report's card drill-down links here with a date range
  // (and optionally a rep) — txn_date_from/txn_date_to aren't schema fields
  // with a visible control (see invoices.ts's whereRange), and sales_rep_list_id
  // isn't a list-visible field either; both still flow through setFilter like
  // is_paid above, they just don't reflect back onto a filter control.
  useEffect(() => {
    if (!schema) return;
    const from = searchParams.get('txn_date_from');
    const to = searchParams.get('txn_date_to');
    const repId = searchParams.get('sales_rep_list_id');
    if (from) baseList.setFilter('txn_date_from', from);
    if (to) baseList.setFilter('txn_date_to', to);
    if (repId) baseList.setFilter('sales_rep_list_id', repId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, searchParams]);

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
        onExportClick={baseList.canExport ? baseList.handleExportAll : undefined}
        pagination={baseList.pagination}
      />
    </div>
  );
};

export default InvoiceList;
