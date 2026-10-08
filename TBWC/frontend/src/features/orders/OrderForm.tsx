import React from 'react';
import { Alert, Box, Button, CircularProgress, MenuItem, TextField, Typography } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { BaseForm, ReferenceSearchField } from '@meterit/framework-frontend/components/form';
import { PickableLineItemsGrid } from '@meterit/framework-frontend/components/datagrid/';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import { useOrdersEnhanced } from './ordersStore';
import { OrderLinesGrid } from './OrderLinesGrid';
import OrderInvoicesPanel from './OrderInvoicesPanel';
import { parseAllTracking, renderTrackingText } from './trackingLink';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import type { DocType } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { tbwcReferenceSearch } from '../../shared/referenceSearch';
import { useAuth } from '../../hooks/useAuth';
import type { Order, OrderLine } from '../../types/order';

// Picks a real QuickBooks customer onto a placeholder order — never a
// free-text name (routes/orders.ts's resolveCustomer is the authoritative
// check; this picker just keeps a typo from ever reaching it).
const CUSTOMER_SEARCH_CONFIG = { endpoint: '/customers', valueField: 'list_id', labelField: 'full_name' };

// Mirrors orderSchema.ts's order_type enumLabels — used for the banner/delete
// confirm text, which needs to say which placeholder type this is.
const PLACEHOLDER_LABELS: Record<string, string> = {
  hold_for_release: 'Hold for Release',
  consignment: 'Consignment',
};

// Reps may see these on an order's Documents tab. Admins see every type.
const REP_VISIBLE_DOC_TYPES: DocType[] = ['packing_slip', 'invoice', 'proof_of_delivery', 'load_schedule'];
const REP_MAX_FILE_SIZE = 20 * 1024 * 1024;
const repOversizeMessage = (file: File) =>
  `"${file.name}" is over the 20MB upload limit. Please contact info@tbwcinc.com for help sending this file.`;

interface OrderFormProps {
  /** A full Order when editing, or a Partial<Order> carrying just
   *  `{ order_type: 'hold_for_release' | 'consignment' }` when opened via the
   *  list's New menu (see OrderManagementPage/OrderList). */
  order?: Partial<Order>;
  onCancel: () => void;
  loading?: boolean;
}

// Header fields that are QB-owned (readOnly in orderSchema.ts) on every
// normal synced order, but fully editable by hand on a placeholder order
// (hold_for_release or consignment), which has no QB source to be clobbered
// by the next sync. Overridden here via renderCustomField rather than in the
// schema itself, so a normal order's form is completely unaffected
// (renderCustomField returns null for these field names unless isPlaceholder,
// falling back to the schema's own readOnly rendering).
// customer_name is deliberately not here — it's picked via ReferenceSearchField
// (see the 'customer_name' branch in renderCustomField), not typed free-text,
// so the customer is always a real QuickBooks one (validated again server-side).
// total isn't here either — like lines, it's computed server-side from the
// line items (routes/orders.ts's sumLines), never independently editable.
const HOLD_FOR_RELEASE_HEADER_FIELDS = new Set([
  'ref_number', 'po_number', 'txn_date', 'due_date',
  'bill_address_block', 'ship_address_block', 'freight_terms', 'ship_via',
  'contact', 'customer_tax_code',
]);

function renderPlaceholderField(fieldDef: any, value: any, disabled: boolean, onChange: (v: any) => void) {
  const common = { fullWidth: true, size: 'small' as const, label: fieldDef?.label, disabled };
  if (fieldDef?.type === 'textarea') {
    return <TextField {...common} multiline minRows={fieldDef.rows || 3} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
  if (fieldDef?.type === 'date') {
    return <TextField {...common} type="date" InputLabelProps={{ shrink: true }} value={value ? String(value).slice(0, 10) : ''} onChange={(e) => onChange(e.target.value || null)} />;
  }
  if (fieldDef?.type === 'currency' || fieldDef?.type === 'number') {
    return <TextField {...common} type="number" value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />;
  }
  return <TextField {...common} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
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
  // order is a full Order when editing/viewing, or just { order_type:
  // 'hold_for_release' | 'consignment' } when opened via the list's New menu —
  // cast since freshOrder only ever needs the fields actually present at each
  // stage.
  const [freshOrder, setFreshOrder] = React.useState<Order | undefined>(order?.id ? undefined : (order as Order | undefined));
  const [fetching, setFetching] = React.useState(!!order?.id);
  const isPlaceholder = freshOrder?.order_type === 'hold_for_release' || freshOrder?.order_type === 'consignment';
  // Picked via a plain dropdown (renderCustomField below), not schema's
  // generic field plumbing — sales_rep is a joined display string, not the
  // real FK (sales_rep_list_id) a placeholder order needs to write.
  const [pendingRepListId, setPendingRepListId] = React.useState<string | null>(null);
  // Same reason, for the customer picker — customer_name is a plain display
  // string; the real FK the server validates (routes/orders.ts's
  // resolveCustomer) is customer_list_id, picked via ReferenceSearchField.
  const [pendingCustomer, setPendingCustomer] = React.useState<{ list_id: string; name: string } | null>(null);
  // Placeholder order line items (add/remove + item picker, see
  // PickableLineItemsGrid below) — not schema field plumbing, same reason as
  // QuoteForm's pendingLines: the grid owns its own add/remove/pick-item state.
  const [pendingLines, setPendingLines] = React.useState<OrderLine[] | null>(null);
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!order?.id) {
      setFreshOrder(order as Order | undefined);
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    orders.fetchItem(order.id)
      .then((fresh) => { if (!cancelled) setFreshOrder(fresh as Order); })
      .catch(() => { if (!cancelled) setFreshOrder(order as Order | undefined); }) // fall back to the stale row rather than block editing entirely
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order?.id]);

  // sales_rep_list_id is spliced into the save payload here rather than via
  // BaseForm's generic field plumbing (see the dropdown above) — mirrors
  // QuoteForm's pendingCustomer pattern for the same reason: the field
  // being picked (a rep) isn't the field being displayed (sales_rep's joined
  // name string).
  const applyPending = React.useCallback((data: any) => ({
    ...data,
    ...(pendingRepListId != null ? { sales_rep_list_id: pendingRepListId } : {}),
    ...(pendingCustomer ? { customer_list_id: pendingCustomer.list_id } : {}),
    ...(pendingLines ? { lines: pendingLines } : {}),
  }), [pendingRepListId, pendingCustomer, pendingLines]);

  const formStore = React.useMemo(() => ({
    ...orders,
    createItem: (data: any) => orders.createItem(applyPending(data)),
    updateItem: (id: string, data: any) => orders.updateItem(id, applyPending(data)),
  }), [orders, applyPending]);

  const handleDelete = async () => {
    if (!freshOrder?.id) return;
    const label = PLACEHOLDER_LABELS[freshOrder.order_type] ?? 'placeholder';
    if (!window.confirm(`Delete this ${label} order? This cannot be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await orders.deleteOrder(String(freshOrder.id));
      onCancel();
    } catch (e: any) {
      setDeleteError(e?.message || 'Delete failed');
    } finally {
      setDeleting(false);
    }
  };

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
    <Box>
      {isAdmin && isPlaceholder && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Alert severity="info" sx={{ py: 0, flex: 1 }}>
            {PLACEHOLDER_LABELS[freshOrder!.order_type]} — editable in full, never sent to QuickBooks. Delete this once the real order is entered in QuickBooks.
          </Alert>
          {freshOrder?.id && (
            <Button
              variant="outlined"
              color="error"
              size="small"
              startIcon={deleting ? <CircularProgress size={16} /> : <DeleteOutlineIcon />}
              disabled={deleting}
              onClick={handleDelete}
            >
              Delete
            </Button>
          )}
        </Box>
      )}
      {deleteError && <Alert severity="error" sx={{ mb: 2 }}>{deleteError}</Alert>}
        <BaseForm
          schemaName="order"
          entity={freshOrder}
          store={formStore}
          onCancel={onCancel}
          className="order-form"
          loading={loading}
          showTabs={true}
          variant={variant}
          isDisabled={readOnly}
          hiddenTabs={hiddenTabs}
          fieldsToClean={['id', 'lines', 'documents']}
          sidePanel={freshOrder?.id ? <OrderInvoicesPanel orderId={freshOrder.id} order={freshOrder} showMoney={isAdmin} /> : undefined}
          renderCustomField={(fieldName, fieldDef, value, _error, isFieldDisabled, onChange) => {
            if (fieldName === 'lines') {
              // Placeholder order: an addable/removable grid with an item
              // picker (framework's PickableLineItemsGrid) — there's no QB
              // source to build rows from, so the admin builds the order
              // itself. total is computed from these server-side (sumLines).
              if (isPlaceholder) {
                return (
                  <PickableLineItemsGrid
                    lines={pendingLines ?? value ?? []}
                    config={fieldDef.lineItemPicker}
                    disabled={isFieldDisabled}
                    search={tbwcReferenceSearch}
                    onChange={setPendingLines}
                  />
                );
              }
              return <OrderLinesGrid lines={value} total={freshOrder?.total} freight={freshOrder?.freight} hideAmounts={hideLineAmounts} />;
            }
            if (HOLD_FOR_RELEASE_HEADER_FIELDS.has(fieldName)) {
              // Falls back to the schema's own (readOnly) rendering on a
              // normal order — this override exists only for a placeholder.
              if (!isPlaceholder) return null;
              return <Box data-field={fieldName}>{renderPlaceholderField(fieldDef, value, isFieldDisabled, onChange)}</Box>;
            }
            if (fieldName === 'customer_name') {
              // Normal order: customer_name is QB-owned plain text — the
              // schema's own readOnly rendering is correct, unchanged.
              if (!isPlaceholder) return null;
              return (
                <Box data-field="customer_name">
                  <ReferenceSearchField
                    label="Customer"
                    placeholder="Search QuickBooks customers…"
                    config={CUSTOMER_SEARCH_CONFIG}
                    search={tbwcReferenceSearch}
                    disabled={isFieldDisabled}
                    value={pendingCustomer?.list_id ?? freshOrder?.customer_list_id ?? null}
                    valueLabel={pendingCustomer?.name ?? freshOrder?.customer_name ?? null}
                    onChange={(option) => {
                      setPendingCustomer(option ? { list_id: String(option.value), name: option.label } : null);
                      // Also feeds BaseForm's own formData so it displays
                      // immediately — applyPending() above is still what
                      // actually goes on the wire (the real FK, not this name).
                      onChange(option?.label ?? null);
                    }}
                  />
                </Box>
              );
            }
            if (fieldName === 'sales_rep') {
              if (!isPlaceholder) return null;
              const repField = orderSchema?.entityFields?.sales_rep_list_id;
              const repOptions: string[] = repField?.enumValues ?? [];
              const repLabels: Record<string, string> = repField?.enumLabels ?? {};
              return (
                <TextField
                  select
                  fullWidth
                  size="small"
                  label="Sales Rep"
                  disabled={isFieldDisabled}
                  value={pendingRepListId ?? freshOrder?.sales_rep_list_id ?? ''}
                  onChange={(e) => setPendingRepListId(e.target.value || null)}
                >
                  <MenuItem value="">—</MenuItem>
                  {repOptions.map((v) => (
                    <MenuItem key={v} value={v}>{repLabels[v] || v}</MenuItem>
                  ))}
                </TextField>
              );
            }
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
    </Box>
  );
};

export default OrderForm;
