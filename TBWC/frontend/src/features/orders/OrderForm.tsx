import React from 'react';
import { Box, CircularProgress } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { useOrdersEnhanced } from './ordersStore';
import { OrderLinesGrid } from './OrderLinesGrid';
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
      fieldsToClean={['id', 'lines']}
      renderCustomField={(fieldName, _fieldDef, value) => {
        if (fieldName === 'lines') return <OrderLinesGrid lines={value} total={freshOrder?.total} />;
        return null;
      }}
    />
  );
};

export default OrderForm;
