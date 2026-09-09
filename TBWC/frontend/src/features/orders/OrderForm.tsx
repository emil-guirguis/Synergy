import React from 'react';
import { Box, Button, CircularProgress } from '@mui/material';
import LocalShippingIcon from '@mui/icons-material/LocalShipping';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { useOrdersEnhanced } from './ordersStore';
import { OrderLinesGrid } from './OrderLinesGrid';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import type { Order } from '../../types/order';

interface OrderFormProps {
  order?: Order;
  onCancel: () => void;
  loading?: boolean;
}

/** Escape text dropped into the packing-list HTML document below. */
function esc(s: string | null | undefined): string {
  return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

/** Opens a printable packing slip for this order in a new tab (no PDF service — just print-to-PDF). */
function openPackingList(order: Order): void {
  const rows = (order.lines ?? [])
    .map((l) => `<tr><td>${esc(l.item)}</td><td>${esc(l.desc)}</td><td class="qty">${esc(String(l.quantity ?? ''))}</td></tr>`)
    .join('');

  const html = `<!doctype html><html><head><title>Packing List - ${esc(order.ref_number)}</title>
<style>
  body { font-family: Arial, sans-serif; margin: 32px; color: #222; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .meta { margin-bottom: 24px; font-size: 13px; color: #555; }
  .meta div { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
  th { background: #f2f2f2; }
  td.qty, th.qty { text-align: right; width: 80px; }
</style></head>
<body>
  <h1>Packing List</h1>
  <div class="meta">
    <div><strong>Customer:</strong> ${esc(order.customer_name)}</div>
    <div><strong>SO #:</strong> ${esc(order.ref_number)} &nbsp; <strong>PO #:</strong> ${esc(order.po_number)}</div>
    ${order.job_name ? `<div><strong>Job:</strong> ${esc(order.job_name)}</div>` : ''}
    <div><strong>Ship To:</strong><br/>${esc(order.ship_address_block).replace(/\n/g, '<br/>')}</div>
  </div>
  <table>
    <thead><tr><th>Item</th><th>Description</th><th class="qty">Qty</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3">No line items</td></tr>'}</tbody>
  </table>
  <script>window.onload = () => window.print();</script>
</body></html>`;

  const win = window.open('', '_blank');
  if (!win) return;
  win.document.write(html);
  win.document.close();
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

  return (
    <BaseForm
      schemaName="order"
      entity={freshOrder}
      store={orders}
      onCancel={onCancel}
      className="order-form"
      loading={loading}
      showTabs={true}
      fieldsToClean={['id', 'lines', 'packing_list', 'documents']}
      renderCustomField={(fieldName, _fieldDef, value) => {
        if (fieldName === 'lines') return <OrderLinesGrid lines={value} total={freshOrder?.total} />;
        if (fieldName === 'packing_list') {
          return (
            <Button
              variant="outlined"
              startIcon={<LocalShippingIcon />}
              disabled={!freshOrder}
              onClick={() => freshOrder && openPackingList(freshOrder)}
            >
              Packing List
            </Button>
          );
        }
        if (fieldName === 'documents') {
          return (
            <DocumentsGrid
              entityType="order"
              entityId={freshOrder?.id}
              api={documentsApi}
              storage={documentsStorage}
            />
          );
        }
        return null;
      }}
    />
  );
};

export default OrderForm;
