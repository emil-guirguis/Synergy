import React, { useState } from 'react';
import { Box, Card, CardContent, Rating, Typography } from '@mui/material';
import { BaseForm } from '../components/form';
import { FormField } from '../components/common';
import { InvoiceSerialLookup } from './InvoiceSerialLookup';
import type { SupportTicket, SupportTicketsStore, SupportTicketService } from './types';

export interface SupportTicketFormProps {
  ticket?: SupportTicket;
  /** Entity-store hook (same one SupportTicketList/SupportTicketsPage take) - called here to get a
   *  createItem/updateItem/fetchItem store, same shape BaseForm takes everywhere else (e.g. OrderForm's useOrdersEnhanced()). */
  useStore: () => SupportTicketsStore;
  /** For the calls BaseForm's generic store doesn't cover: PO validation, serial-number invoice lookup, CSAT. */
  ticketService: SupportTicketService;
  isAdminSupport: boolean;
  onCancel: () => void;
  /** Renders the Documents tab's content (the app wires its own DocumentsGrid instance). Omit to hide the tab. */
  renderDocuments?: (ticketId: number) => React.ReactNode;
}

/**
 * Schema-driven support-ticket form (GET /api/schema/support_ticket) - same
 * BaseForm + renderCustomField shape every other module uses (see
 * TBWC/frontend/src/features/orders/OrderForm.tsx), replacing what used to be
 * a hand-coded Tabs/Grid/TextField layout kept in sync with the schema by hand.
 *
 * A non-admin filer gets a fully editable form when filing a NEW ticket
 * (POST only requires support:read) but a read-only viewer once it exists
 * (PUT is support:write-gated entirely server-side) - not a per-field
 * editable/disabled mix, since anything short of full read-only on an
 * existing ticket would be showing an editable control that 403s on save.
 * CSAT rating is the one real write action available on an existing ticket,
 * and it's a separate endpoint/card below the form rather than a schema field.
 */
export const SupportTicketForm: React.FC<SupportTicketFormProps> = ({
  ticket, useStore, ticketService, isAdminSupport, onCancel, renderDocuments,
}) => {
  const store = useStore();
  const [poState, setPoState] = useState<{ checking: boolean; result: 'valid' | 'invalid' | null; order_number?: string; customer_name?: string }>({ checking: false, result: null });
  const [csatTicket, setCsatTicket] = useState<SupportTicket | undefined>(ticket);
  const [csatSubmitting, setCsatSubmitting] = useState(false);

  const effectiveTicket = csatTicket ?? ticket;

  const checkPo = async (po: string) => {
    const trimmed = po?.trim();
    if (!ticketService.validatePo || !trimmed) { setPoState({ checking: false, result: null }); return; }
    setPoState({ checking: true, result: null });
    try {
      const r = await ticketService.validatePo(trimmed);
      setPoState({ checking: false, result: r.valid ? 'valid' : 'invalid', order_number: r.order_number, customer_name: r.customer_name });
    } catch {
      setPoState({ checking: false, result: null });
    }
  };

  const handleCsat = async (value: number) => {
    if (!effectiveTicket?.support_ticket_id) return;
    setCsatSubmitting(true);
    try {
      setCsatTicket(await ticketService.submitCsat(effectiveTicket.support_ticket_id, value));
    } finally {
      setCsatSubmitting(false);
    }
  };

  // Matched against status/assigned_to_users_id/resolution_notes's
  // visibleFor: ['admin', 'filer-view'] in supportTicketSchema.ts — those
  // fields (and the whole Resolution tab) are meaningless on a ticket that
  // doesn't exist yet, so a filer filing a new one doesn't see them at all,
  // rather than seeing them editable-but-silently-ignored by the server.
  const variant = isAdminSupport ? 'admin' : (ticket ? 'filer-view' : 'filer-create');

  return (
    <Box>
      <BaseForm
        schemaName="support_ticket"
        entity={ticket}
        store={store}
        onCancel={onCancel}
        className="support-ticket-form"
        showTabs
        variant={variant}
        isDisabled={!isAdminSupport && !!ticket}
        // created_at/assigned_to_name are schema fields too (showOn:['list'])
        // but BaseForm doesn't gate rendering by showOn itself — only the
        // list/filter generator reads it — so without this they'd render
        // alongside opened_at/assigned_to_users_id as duplicate "Opened"/
        // "Assigned To" controls. See supportTicketSchema.ts's comments.
        excludeFields={['created_at', 'assigned_to_name']}
        fieldsToClean={['id', 'documents', 'ticket_number', 'opened_at']}
        renderCustomField={(fieldName, fieldDef, value, _error, isFieldDisabled, onChange) => {
          if (fieldName === 'po_number') {
            // Same FormField the schema's own renderer would use for a plain
            // string field - only the onBlur validation hook and helper text
            // below are custom, so this still looks identical to every other
            // text field in the form.
            const helperColor = poState.result === 'valid' ? 'success.main' : poState.result === 'invalid' ? 'warning.main' : 'text.secondary';
            const helperText = poState.checking ? 'Checking...'
              : poState.result === 'valid' ? `Matches order ${poState.order_number ?? ''}${poState.customer_name ? ` (${poState.customer_name})` : ''}`
              : poState.result === 'invalid' ? 'No matching order found'
              : undefined;
            return (
              <Box data-field="po_number">
                <FormField
                  name="po_number"
                  label={fieldDef?.label ?? 'PO Number'}
                  type="text"
                  value={value ?? ''}
                  disabled={isFieldDisabled}
                  onChange={(e: any) => { onChange(e.target.value); setPoState({ checking: false, result: null }); }}
                  onBlur={(e: any) => checkPo(e.target.value)}
                />
                {helperText && (
                  <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: helperColor }}>
                    {helperText}
                  </Typography>
                )}
              </Box>
            );
          }
          if (fieldName === 'serial_number') {
            return (
              <Box data-field="serial_number">
                <FormField
                  name="serial_number"
                  label={fieldDef?.label ?? 'Serial Number'}
                  type="text"
                  value={value ?? ''}
                  disabled={isFieldDisabled}
                  onChange={(e: any) => onChange(e.target.value)}
                />
                {ticketService.findInvoicesBySerial && (
                  <InvoiceSerialLookup serial={value} lookup={ticketService.findInvoicesBySerial} />
                )}
              </Box>
            );
          }
          if (fieldName === 'documents') {
            return renderDocuments && effectiveTicket?.support_ticket_id
              ? renderDocuments(effectiveTicket.support_ticket_id)
              : <Typography variant="body2" color="text.secondary">Save the ticket first to attach documents.</Typography>;
          }
          return null;
        }}
      />

      {!isAdminSupport && effectiveTicket && ['resolved', 'closed'].includes(effectiveTicket.status) && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            {effectiveTicket.csat_rating ? (
              <>
                <Typography variant="subtitle2" gutterBottom>Thanks for your feedback</Typography>
                <Rating value={effectiveTicket.csat_rating} readOnly />
              </>
            ) : (
              <>
                <Typography variant="subtitle2" gutterBottom>How did we do?</Typography>
                <Rating
                  value={null}
                  disabled={csatSubmitting}
                  onChange={(_, v) => { if (v) void handleCsat(v); }}
                />
              </>
            )}
          </CardContent>
        </Card>
      )}
    </Box>
  );
};

export default SupportTicketForm;
