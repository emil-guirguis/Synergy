import React from 'react';
import { Alert, Box, CircularProgress, IconButton, TextField, Tooltip } from '@mui/material';
import EmailOutlinedIcon from '@mui/icons-material/EmailOutlined';
import PhoneOutlinedIcon from '@mui/icons-material/PhoneOutlined';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { formatDate } from '@meterit/framework-frontend/utils';
import { OrderLinesGrid } from '../orders/OrderLinesGrid';
import { DocumentsGrid, allowedDocTypes } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { useInvoices, invoiceService } from './invoiceStore';
import { noticeNumberOf, todayLocal, telHrefFor } from './noticeActions';
import { useAuth } from '../../hooks/useAuth';
import type { Invoice } from '../../types/invoice';

interface InvoiceFormProps {
  invoice?: Invoice;
  onCancel: () => void;
}

/** True once an email actually went out for notice `n` — routes/invoices.ts
 *  (sendInvoiceNoticeEmail) is what sets this, and the same route refuses to
 *  let a PUT touch date/method for a locked slot, so this is read-only from
 *  here on. A phone-logged notice (method 'phone') is never locked. */
function noticeLocked(invoice: Invoice | undefined, n: number): boolean {
  return (invoice as any)?.[`notice_${n}_method`] === 'email' && !!(invoice as any)?.[`notice_${n}_date`];
}

/**
 * Schema-driven invoice form (GET /api/schema/invoice). Every QB-synced field
 * is readOnly; the AR tab (collection notices + AR notes, migration 118) is
 * writable, and InvoiceManagementPage shows the Save button only when the
 * caller holds invoice:write.
 *
 * qb_invoice is a QuickBooks staging mirror; always re-fetches fresh on open
 * so balance/is_paid reflect the latest sync rather than the list's cached row
 * — and so the AR tab's Avg Days to Pay, which the detail route derives rather
 * than storing, is present at all (the list never carries it).
 */
export const InvoiceForm: React.FC<InvoiceFormProps> = ({ invoice, onCancel }) => {
  const invoices = useInvoices();
  const { isFieldVisible, scopeOf } = useAuth();
  // Same grant the Save button answers to (InvoiceManagementPage): a caller who
  // can't save an AR edit has no use for a button whose whole job is to make one.
  const canEditAr = scopeOf('invoice:write') !== null;
  const [freshInvoice, setFreshInvoice] = React.useState<Invoice | undefined>(invoice?.id ? undefined : invoice);
  const [fetching, setFetching] = React.useState(!!invoice?.id);
  // Which notice slot is mid-send (disables every notice button, not just
  // the one clicked, so a second click can't race the first) — and the
  // result of the last send, since this happens outside Save/dirty-state
  // entirely (the Worker sends + locks + documents it in one request).
  const [sendingNotice, setSendingNotice] = React.useState<number | null>(null);
  const [noticeResult, setNoticeResult] = React.useState<{ type: 'success' | 'error'; message: string } | null>(null);

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

  /**
   * The Email notice button's click handler. Unlike the old mailto:/share-sheet
   * flow, this is a real send (the Worker's own mail pipeline) that locks the
   * slot and attaches a copy to the Documents tab — see
   * routes/invoices.ts's sendInvoiceNoticeEmail, also used by the AR Aging
   * report's row-checkbox bulk send, so both paths behave identically.
   *
   * `n` is always the section the sender clicked (1st/2nd/3rd), not an
   * auto-picked slot — unlike the bulk send, which has no section to read a
   * choice off and so sends whichever is next. Re-fetches the invoice after
   * a successful send so the now-locked date/method and the new Documents
   * row show up without the sender having to reopen the record.
   */
  const handleEmailNotice = async (n: number) => {
    const invoiceId = freshInvoice?.qb_invoice_id ?? freshInvoice?.id;
    if (invoiceId == null) return;
    setSendingNotice(n);
    setNoticeResult(null);
    try {
      const result = await invoiceService.sendNoticeEmail(invoiceId, todayLocal(), n);
      setNoticeResult({ type: 'success', message: `Notice ${result.notice} emailed to ${result.recipient}.` });
      const fresh = await invoices.fetchItem(String(invoiceId));
      setFreshInvoice(fresh as Invoice);
    } catch (e: any) {
      setNoticeResult({ type: 'error', message: e?.message || 'Failed to send the notice email' });
    } finally {
      setSendingNotice(null);
    }
  };

  return (
    <>
      {noticeResult && (
        <Alert severity={noticeResult.type} sx={{ mb: 1.5 }} onClose={() => setNoticeResult(null)}>
          {noticeResult.message}
        </Alert>
      )}
      <BaseForm
        schemaName="invoice"
        entity={freshInvoice}
        store={invoices}
        onCancel={onCancel}
        className="invoice-form"
        showTabs={true}
        // Computed/joined read-only values the API sends but no PUT accepts —
        // stripped client-side too so the payload says what it means (the
        // WRITABLE allowlist in invoices.ts drops them regardless).
        fieldsToClean={[
          'id', 'lines', 'linked_txn', 'documents',
          'sales_rep', 'days_past_due', 'total_past_due', 'avg_days_to_pay',
        ]}
        /**
         * Email/phone buttons in each notice section's title bar. Phone just
         * stamps today's date/method locally (nothing to send, nothing to
         * attach) — Save persists it like any other AR edit. Email is a real,
         * immediate send (handleEmailNotice above): it hits the server right
         * from this click, independent of Save, and the slot is locked the
         * moment it succeeds — see noticeLocked.
         *
         * Contact details come off the joined qb_customer (detail route only,
         * see invoices.ts) — ~95% of invoices have an email, ~57% a phone, so
         * a button with nothing to dial/send is disabled and says why.
         */
        renderSectionActions={canEditAr ? ({ sectionName, updateField }) => {
          const n = noticeNumberOf(sectionName);
          if (n === null) return null;
          const locked = noticeLocked(freshInvoice, n);
          const hasEmail = !!freshInvoice?.customer_email;
          const tel = telHrefFor(freshInvoice?.customer_phone);
          const sending = sendingNotice === n;
          return (
            <>
              <Tooltip
                title={
                  locked ? `Already emailed on ${formatDate(((freshInvoice as any)?.[`notice_${n}_date`]))}`
                    : !hasEmail ? 'No email on file for this customer'
                    : `Email ${freshInvoice?.customer_email} and log notice ${n}`
                }
              >
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Email notice ${n}`}
                    disabled={locked || !hasEmail || sendingNotice !== null}
                    onClick={() => void handleEmailNotice(n)}
                  >
                    {sending ? <CircularProgress size={16} /> : <EmailOutlinedIcon fontSize="small" />}
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={locked ? 'Notice already emailed' : tel ? `Call ${freshInvoice?.customer_phone} and log notice ${n}` : 'No phone on file for this customer'}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Call notice ${n}`}
                    disabled={locked || !tel}
                    onClick={() => {
                      // Logged locally only — Save persists it, same as every
                      // other AR field. Nothing is sent or attached for a call.
                      updateField(`notice_${n}_date`, todayLocal());
                      updateField(`notice_${n}_method`, 'phone');
                      window.location.href = tel!;
                    }}
                  >
                    <PhoneOutlinedIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          );
        } : undefined}
        renderCustomField={(fieldName, fieldDef, value) => {
          if (fieldName === 'lines') return <OrderLinesGrid lines={value} schemaName="invoiceGridLine" total={freshInvoice?.total} />;
          if (fieldName === 'documents') {
            return (
              <DocumentsGrid
                entityType="invoice"
                entityId={freshInvoice?.id}
                api={documentsApi}
                storage={documentsStorage}
                classifyDocType={classifyDocTypeForFile}
                // Reps get invoices view-only, attachments included.
                schemaName="invoiceGridDocument"
                visibleDocTypes={allowedDocTypes(isFieldVisible, 'invoiceGridDocument:read')}
                canCreate={scopeOf('invoiceGridDocument:create') !== null}
                canEdit={scopeOf('invoiceGridDocument:write') !== null}
                canDelete={scopeOf('invoiceGridDocument:delete') !== null}
              />
            );
          }
          // A locked notice's date/method render as plain disabled text
          // instead of the normal date/select control — sendInvoiceNoticeEmail
          // already stamped these server-side, and the PUT route refuses to
          // move them again (noticeLocked), so an editable control here would
          // just invite a Save that silently does nothing.
          const noticeMatch = /^notice_([123])_(date|method)$/.exec(fieldName);
          if (noticeMatch && noticeLocked(freshInvoice, Number(noticeMatch[1]))) {
            const display = noticeMatch[2] === 'date' ? formatDate(value) : (fieldDef?.enumLabels?.[value] ?? value);
            return (
              <TextField
                size="small" fullWidth disabled label={fieldDef?.label}
                value={display ?? ''} helperText="Locked — this notice was emailed"
              />
            );
          }
          return null;
        }}
      />
    </>
  );
};

export default InvoiceForm;
