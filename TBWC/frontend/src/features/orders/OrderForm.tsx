import React from 'react';
import { Box, CircularProgress, Typography } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { useOrdersEnhanced } from './ordersStore';
import { OrderLinesGrid } from './OrderLinesGrid';
import OrderInvoicesPanel from './OrderInvoicesPanel';
import { parseAllTracking, renderTrackingText } from './trackingLink';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import type { DocType } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { useAuth } from '../../hooks/useAuth';
import type { Order } from '../../types/order';

// Reps may see these on an order's Documents tab. Admins see every type.
const REP_VISIBLE_DOC_TYPES: DocType[] = ['packing_slip', 'invoice', 'proof_of_delivery', 'load_schedule'];
const REP_MAX_FILE_SIZE = 20 * 1024 * 1024;
const repOversizeMessage = (file: File) =>
  `"${file.name}" is over the 20MB upload limit. Please contact info@tbwcinc.com for help sending this file.`;

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
  const { user, isFieldVisible } = useAuth();
  // Reps get a cut-down form: the general Order tab, Line Items, and (now)
  // Documents tabs. The other tabs carry visibleFor: ['admin'] in
  // orderSchema.ts, and BaseForm's `variant` filter drops any tab whose
  // visibleFor doesn't include the variant (tabs without visibleFor are
  // always shown).
  const isAdmin = !!user?.is_admin;
  const variant = isAdmin ? 'admin' : 'rep';
  // PUT /api/orders/:id is requireAdmin, so a rep's form is a viewer: every
  // field disabled, and OrderManagementPage hides the Save button to match.
  const readOnly = !isAdmin;
  // Documents are a separate CRUD path (/api/documents, not the order PUT
  // above). A plain rep's grid is view-only; a "managing rep" — one who
  // manages at least one other user via the Users form's Manages tab
  // (public.user_manager) — can add/edit, matching the elevated access that
  // relation already grants them over those users' orders (orders.ts's
  // ownOnly scoping). managed_sales_rep_list_ids is loadProfile()'s
  // pre-joined view of that relation (see middleware.ts).
  const canWriteDocuments = isAdmin || (user?.managed_sales_rep_list_ids?.length ?? 0) > 0;
  // Settings > Roles' field-security grid (Order > Fields > Line Items) can
  // hide Rate/Amount independently of the rep/admin split above — defaults
  // to visible for everyone until a role's order:read grant says otherwise,
  // so this is additive to readOnly, never narrower than it already was.
  const hideLineAmounts =
    readOnly || !isFieldVisible('order:read', 'lines[].rate') || !isFieldVisible('order:read', 'lines[].amount');
  // Same field-security grid, one level up: Settings > Roles > Order > Fields
  // has a checkbox per tab (addressed as tab:<Name>, see RolesForm.tsx) that
  // feeds straight into BaseForm's own hiddenTabs prop — on top of, not
  // instead of, the existing visibleFor:['admin'] tabs above.
  const { schema: orderSchema } = useSchema('order');
  const hiddenTabs = (orderSchema?.formTabs ?? [])
    .filter((tab) => !isFieldVisible('order:read', `tab:${tab.name}`))
    .map((tab) => tab.name);
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

  // QB-style billing panel (linked invoices + packing slips), pinned beside
  // the form — only for a saved order, since the panel keys off the record
  // id. BaseForm's sidePanel prop owns the responsive row/stack split.
  return (
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
          hiddenTabs={hiddenTabs}
          fieldsToClean={['id', 'lines', 'documents']}
          sidePanel={freshOrder?.id ? <OrderInvoicesPanel orderId={freshOrder.id} order={freshOrder} showMoney={isAdmin} /> : undefined}
          renderCustomField={(fieldName, fieldDef, value) => {
            if (fieldName === 'lines') return <OrderLinesGrid lines={value} total={freshOrder?.total} freight={freshOrder?.freight} hideAmounts={hideLineAmounts} />;
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
                  readOnly={!canWriteDocuments}
                  visibleDocTypes={isAdmin ? undefined : REP_VISIBLE_DOC_TYPES}
                  maxFileSize={isAdmin ? undefined : REP_MAX_FILE_SIZE}
                  oversizeMessage={isAdmin ? undefined : repOversizeMessage}
                />
          );
        }
        return null;
      }}
    />
  );
};

export default OrderForm;
