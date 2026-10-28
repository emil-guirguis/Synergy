-- TBWC migration 118 — AR collections tracking on invoices (nav: Invoices >
-- a record > AR tab).
--
-- Three dated collection notices (date + how we contacted them + a free-text
-- note each) plus one general AR note. These are the FIRST writable columns on
-- public.qb_invoice: the table is a QuickBooks staging mirror and every other
-- column is overwritten by the QBWC pull, so these are TBWC-owned the same way
-- qb_sales_order's build_notes/job_name/sold_for are (see migration 021). The
-- sync never names them, so a re-sync leaves them alone; routes/invoices.ts's
-- WRITABLE allowlist is what stops a PUT touching anything else.
--
-- No CHECK on *_method: the allowed values live in code (invoicesSchema.ts's
-- enumValues, enforced by the PUT route), so adding "letter" later is a code
-- change rather than another migration. See permissions.ts's header for the
-- same reasoning applied to permissions.
--
-- Average Days to Pay is deliberately NOT a column here: QuickBooks does not
-- send it over qbXML (CustomerQueryRq returns no AverageDaysToPay — verified
-- against all 1,026 synced customers), so it is derived per customer from
-- qb_payment.applied_to at read time in routes/invoices.ts. Storing it would
-- just be a copy going stale after every payment.
--
-- Additive and idempotent: IF NOT EXISTS throughout, and the grant conflicts
-- away. Apply once.

ALTER TABLE public.qb_invoice
  ADD COLUMN IF NOT EXISTS notice_1_date   date,
  ADD COLUMN IF NOT EXISTS notice_1_method text,
  ADD COLUMN IF NOT EXISTS notice_1_note   text,
  ADD COLUMN IF NOT EXISTS notice_2_date   date,
  ADD COLUMN IF NOT EXISTS notice_2_method text,
  ADD COLUMN IF NOT EXISTS notice_2_note   text,
  ADD COLUMN IF NOT EXISTS notice_3_date   date,
  ADD COLUMN IF NOT EXISTS notice_3_method text,
  ADD COLUMN IF NOT EXISTS notice_3_note   text,
  ADD COLUMN IF NOT EXISTS ar_notes        text;

COMMENT ON COLUMN public.qb_invoice.notice_1_date   IS 'TBWC-owned. Date the 1st collection notice went out. Never touched by the QBWC sync.';
COMMENT ON COLUMN public.qb_invoice.notice_1_method IS 'TBWC-owned. How the 1st notice was sent (email/phone); allowed values live in invoicesSchema.ts.';
COMMENT ON COLUMN public.qb_invoice.notice_1_note   IS 'TBWC-owned. Free-text note on the 1st notice.';
COMMENT ON COLUMN public.qb_invoice.notice_2_date   IS 'TBWC-owned. Date the 2nd collection notice went out.';
COMMENT ON COLUMN public.qb_invoice.notice_2_method IS 'TBWC-owned. How the 2nd notice was sent (email/phone).';
COMMENT ON COLUMN public.qb_invoice.notice_2_note   IS 'TBWC-owned. Free-text note on the 2nd notice.';
COMMENT ON COLUMN public.qb_invoice.notice_3_date   IS 'TBWC-owned. Date the 3rd collection notice went out.';
COMMENT ON COLUMN public.qb_invoice.notice_3_method IS 'TBWC-owned. How the 3rd notice was sent (email/phone).';
COMMENT ON COLUMN public.qb_invoice.notice_3_note   IS 'TBWC-owned. Free-text note on the 3rd notice.';
COMMENT ON COLUMN public.qb_invoice.ar_notes        IS 'TBWC-owned. General AR/collections note on this invoice, independent of the three notices.';

COMMENT ON TABLE public.qb_invoice IS
  'QuickBooks Desktop Invoice staging table (synced via QBWC), extended with TBWC-owned AR columns the sync never touches. See COMMENT ON COLUMN for the split; invoicesSchema.ts readOnly flag + invoices.ts WRITABLE are the authoritative sources.';

-- invoice:write (AR tab edits) — Administrator only on day one. It is an
-- ordinary catalog permission, so Settings > Roles can hand it to any other
-- role, at any scope, with no further migration.
INSERT INTO public.role_permission (role_id, permission, scope)
SELECT role_id, 'invoice:write', 'all'
  FROM public.role r
 WHERE r.code = 'admin'
ON CONFLICT (role_id, permission) DO NOTHING;
