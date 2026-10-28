import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { InvoiceList } from './InvoiceList';
import { InvoiceForm } from './InvoiceForm';
import { searchPeople, shareRecord } from '../../services/shareService';
import { invoiceShareUrl, invoiceShareTitle } from './invoiceShare';
import { useAuth } from '../../hooks/useAuth';
import type { Invoice } from '../../types/invoice';

/**
 * QuickBooks Invoices — viewer + detail form. QB is the source of truth for
 * every field except the AR tab (collection notices + AR notes, migration
 * 118), so the Save button appears only for a caller holding invoice:write.
 * Without that grant the form is exactly what it was before: read-only.
 */
export const InvoiceManagementPage: React.FC = () => {
  const { scopeOf } = useAuth();
  const canEditAr = scopeOf('invoice:write') !== null;

  return (
  <EntityManagementPage<Invoice>
    title="Invoice"
    moduleIcon="invoices"
    modalSize="lg"
    showSaveButton={canEditAr}
    editLabel={(entity) =>
      `${canEditAr ? 'Invoice' : 'View Invoice'} ${entity.ref_number ?? ''}`.trim()}
    renderList={({ onEdit }) => <InvoiceList onInvoiceView={onEdit} />}
    renderForm={({ entity, onCancel }) => <InvoiceForm invoice={entity} onCancel={onCancel} />}
    shareUrl={invoiceShareUrl}
    shareTitle={invoiceShareTitle}
    searchPeople={searchPeople}
    onShare={({ recipient, note, url, title }) => shareRecord({ recipientUserId: recipient.id, title, linkUrl: url, note })}
  />
  );
};

export default InvoiceManagementPage;
