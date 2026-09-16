import React from 'react';
import { Box, CircularProgress, Table, TableBody, TableCell, TableHead, TableRow, Typography } from '@mui/material';
import { BaseForm } from '@meterit/framework-frontend/components/form';
import { usePayments } from './paymentStore';
import type { Payment } from '../../types/payment';

interface PaymentFormProps {
  payment?: Payment;
  onCancel: () => void;
}

function formatCurrency(value: number | null): string {
  if (value === null || value === undefined) return '';
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * Schema-driven payment viewer (GET /api/schema/payment) — read-only, no save.
 * qb_payment is a QuickBooks staging mirror; always re-fetches fresh on open
 * so unapplied_amount reflects the latest sync rather than the list's cached row.
 */
export const PaymentForm: React.FC<PaymentFormProps> = ({ payment, onCancel }) => {
  const payments = usePayments();
  const [freshPayment, setFreshPayment] = React.useState<Payment | undefined>(payment?.id ? undefined : payment);
  const [fetching, setFetching] = React.useState(!!payment?.id);

  React.useEffect(() => {
    if (!payment?.id) {
      setFreshPayment(payment);
      setFetching(false);
      return;
    }
    let cancelled = false;
    setFetching(true);
    payments.fetchItem(payment.id)
      .then((fresh) => { if (!cancelled) setFreshPayment(fresh as Payment); })
      .catch(() => { if (!cancelled) setFreshPayment(payment); })
      .finally(() => { if (!cancelled) setFetching(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id]);

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <BaseForm
      schemaName="payment"
      entity={freshPayment}
      store={payments}
      onCancel={onCancel}
      className="payment-form"
      showTabs={true}
      fieldsToClean={['id', 'applied_to']}
      renderCustomField={(fieldName, _fieldDef, value) => {
        if (fieldName !== 'applied_to') return null;
        const rows = (value as Payment['applied_to']) || [];
        if (rows.length === 0) {
          return <Typography variant="body2" color="text.secondary">Not applied to any invoice.</Typography>;
        }
        return (
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Ref #</TableCell>
                <TableCell>Type</TableCell>
                <TableCell align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={row.txn_id ?? i}>
                  <TableCell>{row.ref_number}</TableCell>
                  <TableCell>{row.txn_type}</TableCell>
                  <TableCell align="right">{formatCurrency(row.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        );
      }}
    />
  );
};

export default PaymentForm;
