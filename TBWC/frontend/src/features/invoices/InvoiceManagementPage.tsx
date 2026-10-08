import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { InvoiceList } from './InvoiceList';
import { InvoiceForm } from './InvoiceForm';
import { searchPeople, shareRecord } from '../../services/shareService';
import { invoiceShareUrl, invoiceShareTitle } from './invoiceShare';
import type { Invoice } from '../../types/invoice';

/** QuickBooks Invoices — read-only viewer + detail form. No edit/save (source of truth is QB). */
export const InvoiceManagementPage: React.FC = () => (
  <EntityManagementPage<Invoice>
    title="Invoice"
    moduleIcon="invoices"
    modalSize="lg"
    showSaveButton={false}
    editLabel={(entity) => `Invoice ${entity.ref_number ?? ''}`.trim()}
    renderList={({ onEdit }) => <InvoiceList onInvoiceView={onEdit} />}
    renderForm={({ entity, onCancel }) => <InvoiceForm invoice={entity} onCancel={onCancel} />}
    shareUrl={invoiceShareUrl}
    shareTitle={invoiceShareTitle}
    searchPeople={searchPeople}
    onShare={({ recipient, note, url, title }) => shareRecord({ recipientUserId: recipient.id, title, linkUrl: url, note })}
  />
);

export default InvoiceManagementPage;
