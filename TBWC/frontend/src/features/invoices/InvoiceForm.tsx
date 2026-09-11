import React from 'react';
import { Box, CircularProgress } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { OrderLinesGrid } from '../orders/OrderLinesGrid';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { useInvoices } from './invoiceStore';
import { useAuth } from '../../hooks/useAuth';
import type { Invoice } from '../../types/invoice';

interface InvoiceFormProps {
  invoice?: Invoice;
  onCancel: () => void;
}

/**
 * Schema-driven invoice viewer (GET /api/schema/invoice) — read-only, no save.
 * qb_invoice is a QuickBooks staging mirror; always re-fetches fresh on open
 * so balance/is_paid reflect the latest sync rather than the list's cached row.
 */
export const InvoiceForm: React.FC<InvoiceFormProps> = ({ invoice, onCancel }) => {
  const invoices = useInvoices();
  const { isAdmin } = useAuth();
  const [freshInvoice, setFreshInvoice] = React.useState<Invoice | undefined>(invoice?.id ? undefined : invoice);
  const [fetching, setFetching] = React.useState(!!invoice?.id);

  React.useEffect(() => {
    if (!invoice?.id) {
      setFreshInvoice(invoice);
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    invoices.fetchItem(invoice.id)
      .then((fresh) => { if (!cancelled) setFreshInvoice(fresh as Invoice); })
      .catch(() => { if (!cancelled) setFreshInvoice(invoice); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice?.id]);

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <BaseForm
      schemaName="invoice"
      entity={freshInvoice}
      store={invoices}
      onCancel={onCancel}
      className="invoice-form"
      showTabs={true}
      fieldsToClean={['id', 'lines', 'linked_txn', 'documents']}
      renderCustomField={(fieldName, _fieldDef, value) => {
        if (fieldName === 'lines') return <OrderLinesGrid lines={value} total={freshInvoice?.total} />;
        if (fieldName === 'documents') {
          return (
            <DocumentsGrid
              entityType="invoice"
              entityId={freshInvoice?.id}
              api={documentsApi}
              storage={documentsStorage}
              // Reps get invoices view-only, attachments included.
              readOnly={!isAdmin}
            />
          );
        }
        return null;
      }}
    />
  );
};

export default InvoiceForm;
