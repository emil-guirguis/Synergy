import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { useOrdersEnhanced } from './ordersStore';
import { OrderLinesGrid } from './OrderLinesGrid';
import OrderInvoicesPanel from './OrderInvoicesPanel';
import { parseAllTracking, renderTrackingText } from './trackingLink';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { useAuth } from '../../hooks/useAuth';
import type { Order } from '../../types/order';

interface OrderFormProps {
  order?: Order;
  onCancel: () => void;
  loading?: boolean;
}

/**
 * Schema-driven order form (GET /api/schema/order); store handles create/update.
 *
 * Orders carry financial data (commission, D-Net cost, sold-for, etc.) that can
 * change outside the list's own fetch cycle — another user's edit, a direct DB
 * correction. The list's in-memory row cache (ordersStore.ts, 5-30min TTL) is
 * fine for browsing, but showing possibly-stale numbers on the one screen where
 * someone edits money is the wrong kind of bug. So this always re-fetches the
 * record fresh on open instead of trusting the row object the list handed it —
 * BaseForm only initializes its form state from `entity` once on mount (see
 * useSchemaForm.ts's reset effect, keyed on schema, not entity), so the fetch
 * has to resolve BEFORE BaseForm mounts, not by swapping the prop afterward.
 */
export const OrderForm: React.FC<OrderFormProps> = ({ order, onCancel, loading = false }) => {
  const orders = useOrdersEnhanced();
  const { user } = useAuth();
  // Reps get a cut-down form: the general Order tab and the Line Items tab only.
  // The other tabs carry visibleFor: ['admin'] in orderSchema.ts, and BaseForm's
  // `variant` filter drops any tab whose visibleFor doesn't include the variant
  // (tabs without visibleFor are always shown), so 'rep' leaves exactly those two.
  const isAdmin = !!user?.is_admin;
  const variant = isAdmin ? 'admin' : 'rep';
  // PUT /api/orders/:id is requireAdmin, so a rep's form is a viewer: every
  // field disabled, and OrderManagementPage hides the Save button to match.
  const readOnly = !isAdmin;
  const [freshOrder, setFreshOrder] = React.useState<Order | undefined>(order?.id ? undefined : order);
  const [fetching, setFetching] = React.useState(!!order?.id);

  React.useEffect(() => {
    if (!order?.id) {
      setFreshOrder(order);
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    orders.fetchItem(order.id)
      .then((fresh) => { if (!cancelled) setFreshOrder(fresh as Order); })
      .catch(() => { if (!cancelled) setFreshOrder(order); }) // fall back to the stale row rather than block editing entirely
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  // Form on the left, QB-style billing panel pinned right (linked invoices +
  // packing slips). Only for a saved order — the panel keys off the record id.
  return (
    <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <BaseForm
          schemaName="order"
          entity={freshOrder}
          store={orders}
          onCancel={onCancel}
          className="order-form"
          loading={loading}
          showTabs={true}
          variant={variant}
          isDisabled={readOnly}
          fieldsToClean={['id', 'lines', 'documents']}
          renderCustomField={(fieldName, fieldDef, value) => {
            if (fieldName === 'lines') return <OrderLinesGrid lines={value} total={freshOrder?.total} freight={freshOrder?.freight} hideAmounts={readOnly} />;
            // shipping_tracking is free-typed shipping notes off the
            // invoice's FREIGHT line(s) (see orderInvoiceStatus.ts) — a memo,
            // not a single value: a multi-package shipment carries several
            // numbers, one per line/comma/whatever separator the person who
            // typed it used (e.g. six UPS numbers, newline-separated, on
            // order TBWC 5689). Rendered as plain read-only text with each
            // recognized number swapped for a link in place — not a real
            // <textarea> (can't hold clickable content) and not a separate
            // links list either (would just show every number twice).
            // parseAllTracking() only recognizes a number when it's an
            // unambiguous UPS format, or a FedEx one where the text also
            // names FedEx (see its own comment for why).
            if (fieldName === 'shipping_tracking') {
              const tracking = parseAllTracking(value);
              return (
                <Box data-field="shipping_tracking">
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                    {fieldDef?.label ?? 'Shipping / Tracking'}
                  </Typography>
                  <Box
                    sx={{
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 1,
                      px: 1.5,
                      py: 1,
                      minHeight: '2.5em',
                      bgcolor: 'action.hover',
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      fontSize: '0.875rem',
                      lineHeight: 1.5,
                    }}
                  >
                    {value ? renderTrackingText(value, tracking) : <Typography component="span" variant="body2" color="text.disabled">—</Typography>}
                  </Box>
                </Box>
              );
            }
            if (fieldName === 'documents') {
              return (
                <DocumentsGrid
                  entityType="order"
                  entityId={freshOrder?.id}
                  api={documentsApi}
                  storage={documentsStorage}
                  classifyDocType={classifyDocTypeForFile}
                />
          );
        }
        return null;
      }}
    />
      </Box>
      {freshOrder?.id && (
        <OrderInvoicesPanel orderId={freshOrder.id} order={freshOrder} showMoney={isAdmin} />
      )}
    </Box>
  );
};

export default OrderForm;
