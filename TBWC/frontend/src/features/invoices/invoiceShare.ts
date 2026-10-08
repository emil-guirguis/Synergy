import type { Invoice } from '../../types/invoice';

export const invoiceShareUrl = (invoice: Invoice) => `${window.location.origin}/invoices?openId=${invoice.qb_invoice_id}`;
export const invoiceShareTitle = (invoice: Invoice) => `Invoice ${invoice.ref_number ?? invoice.qb_invoice_id}`;
