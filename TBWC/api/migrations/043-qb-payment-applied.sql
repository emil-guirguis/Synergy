-- qb_payment.applied_to / unapplied_amount: which invoice(s) a ReceivePayment
-- was applied to, and how much of it is still an unapplied customer credit.
--
-- Why: re-enabling the Payment sync (qbwc/objects/payment.ts) as the AR
-- module needs more than the raw payment total to be useful for AR tracking
-- -- it needs to say which invoice a payment covers. QB's AppliedToTxnRet
-- blocks carry that; unapplied_amount is derived (total_amount minus the sum
-- of applied amounts) rather than trusted from a QB field, since
-- ReceivePaymentRet does not return that total directly.
ALTER TABLE public.qb_payment
  ADD COLUMN IF NOT EXISTS applied_to jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS unapplied_amount numeric(15,2);

COMMENT ON COLUMN public.qb_payment.applied_to IS
  'QB AppliedToTxnRet blocks: [{txn_id, txn_type, ref_number, amount}], which invoice(s) this payment covers.';
COMMENT ON COLUMN public.qb_payment.unapplied_amount IS
  'total_amount minus sum(applied_to[].amount) -- unapplied customer credit. Computed at sync time, not a QB field.';
