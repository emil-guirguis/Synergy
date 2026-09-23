/**
 * Rep Performance & Commission Tracker — admin/employee-only aggregate report.
 * Not a CRUD module (no schema, no list/detail); a single summary endpoint that
 * runs five independent per-rep GROUP BY queries against the QB-synced staging
 * tables and merges them in JS by qb_sales_rep.list_id, rather than one large
 * join — each figure has a different natural grain (invoices, payments,
 * orders) and a join across all of them would double-count.
 *
 * Caveat surfaced to the frontend via `invoiceStatusMayBeStale`: commission
 * payout gates on qb_sales_order.invoice_status = 'Paid', which is denormalised
 * from qb_invoice.linked_txn (see qbwc/orderInvoiceStatus.ts) — linked_txn was
 * '[]' on every invoice until IncludeLinkedTxns was added to the pull, so
 * older orders may still read 'Not Invoiced' until the next full resync
 * backfills it.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission } from '../middleware';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('report:read'));

interface RepRow {
  list_id: string;
  name: string;
  booked: number;
  invoiceCount: number;
  collected: number;
  commissionPaid: number;
  paidOrderCount: number;
  revenue: number;
  grossProfit: number;
  avgCollectionDays: number | null;
}

app.get('/summary', async (c) => {
  const yearParam = parseInt(c.req.query('year') ?? '', 10);
  const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();

  const [reps, booked, collected, commission, margin, collectionDays, years] = await Promise.all([
    execQuery(
      c.env,
      `SELECT list_id, name FROM public.qb_sales_rep WHERE is_active = true AND qb_deleted_at IS NULL ORDER BY name`,
      [],
      'repPerformance.reps'
    ),
    // Total invoiced per rep — "booked sales" side of the comparison.
    execQuery(
      c.env,
      `SELECT sales_rep_list_id AS list_id, COALESCE(SUM(total), 0)::numeric AS booked, COUNT(*)::int AS invoice_count
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL AND sales_rep_list_id IS NOT NULL
          AND extract(year FROM txn_date)::int = $1
        GROUP BY sales_rep_list_id`,
      [year],
      'repPerformance.booked'
    ),
    // Payments applied to this rep's invoices, dated by when the payment
    // landed (not the invoice date) — unnest applied_to and re-attribute via
    // the invoice it names, since qb_payment itself carries no rep.
    execQuery(
      c.env,
      `SELECT i.sales_rep_list_id AS list_id, COALESCE(SUM((elem->>'amount')::numeric), 0)::numeric AS collected
         FROM public.qb_payment p
         CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.applied_to, '[]'::jsonb)) AS elem
         JOIN public.qb_invoice i ON i.txn_id = elem->>'txn_id' AND i.qb_deleted_at IS NULL
        WHERE elem->>'txn_type' = 'Invoice' AND i.sales_rep_list_id IS NOT NULL
          AND extract(year FROM p.txn_date)::int = $1
        GROUP BY i.sales_rep_list_id`,
      [year],
      'repPerformance.collected'
    ),
    // Commission payout ledger — only orders whose linked invoice has actually
    // been paid (invoice_status = 'Paid'), so bad debt never earns a payout.
    // commission_total = commission + overage (the GENERATED column).
    execQuery(
      c.env,
      `SELECT sales_rep_list_id AS list_id, COALESCE(SUM(commission_total), 0)::numeric AS commission_paid, COUNT(*)::int AS paid_order_count
         FROM public.qb_sales_order
        WHERE qb_deleted_at IS NULL AND sales_rep_list_id IS NOT NULL
          AND invoice_status = 'Paid'
          AND extract(year FROM txn_date)::int = $1
        GROUP BY sales_rep_list_id`,
      [year],
      'repPerformance.commission'
    ),
    // Gross profit margin per rep — sold_for vs. d_net_cost, every order
    // booked in the year regardless of payment status (a sales metric, not a
    // cash one).
    execQuery(
      c.env,
      `SELECT sales_rep_list_id AS list_id,
              COALESCE(SUM(sold_for), 0)::numeric AS revenue,
              COALESCE(SUM(sold_for - d_net_cost), 0)::numeric AS gross_profit
         FROM public.qb_sales_order
        WHERE qb_deleted_at IS NULL AND sales_rep_list_id IS NOT NULL
          AND extract(year FROM txn_date)::int = $1
        GROUP BY sales_rep_list_id`,
      [year],
      'repPerformance.margin'
    ),
    // Average days from invoice date to first payment applied to it, for
    // invoices issued in the year that have collected at least one payment.
    execQuery(
      c.env,
      `SELECT i.sales_rep_list_id AS list_id, AVG(first_pay.pay_date - i.txn_date)::numeric AS avg_days
         FROM public.qb_invoice i
         JOIN LATERAL (
           SELECT MIN(p.txn_date) AS pay_date
             FROM public.qb_payment p, jsonb_array_elements(COALESCE(p.applied_to, '[]'::jsonb)) elem
            WHERE elem->>'txn_id' = i.txn_id AND elem->>'txn_type' = 'Invoice'
         ) first_pay ON first_pay.pay_date IS NOT NULL
        WHERE i.qb_deleted_at IS NULL AND i.sales_rep_list_id IS NOT NULL
          AND extract(year FROM i.txn_date)::int = $1
        GROUP BY i.sales_rep_list_id`,
      [year],
      'repPerformance.collectionDays'
    ),
    // Every year with invoice data, for the page's year picker — same pattern
    // as invoices.ts's receivables-summary.
    execQuery(
      c.env,
      `SELECT DISTINCT extract(year FROM txn_date)::int AS y
         FROM public.qb_invoice
        WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
        ORDER BY y DESC`,
      [],
      'repPerformance.years'
    ),
  ]);

  const bookedByRep = new Map(booked.rows.map((r: any) => [r.list_id, r]));
  const collectedByRep = new Map(collected.rows.map((r: any) => [r.list_id, r]));
  const commissionByRep = new Map(commission.rows.map((r: any) => [r.list_id, r]));
  const marginByRep = new Map(margin.rows.map((r: any) => [r.list_id, r]));
  const collectionDaysByRep = new Map(collectionDays.rows.map((r: any) => [r.list_id, r]));

  const items: RepRow[] = reps.rows.map((rep: any) => {
    const b = bookedByRep.get(rep.list_id);
    const col = collectedByRep.get(rep.list_id);
    const comm = commissionByRep.get(rep.list_id);
    const m = marginByRep.get(rep.list_id);
    const cd = collectionDaysByRep.get(rep.list_id);
    const revenue = Number(m?.revenue ?? 0);
    const grossProfit = Number(m?.gross_profit ?? 0);
    return {
      list_id: rep.list_id,
      name: rep.name,
      booked: Number(b?.booked ?? 0),
      invoiceCount: Number(b?.invoice_count ?? 0),
      collected: Number(col?.collected ?? 0),
      commissionPaid: Number(comm?.commission_paid ?? 0),
      paidOrderCount: Number(comm?.paid_order_count ?? 0),
      revenue,
      grossProfit,
      avgCollectionDays: cd?.avg_days != null ? Number(cd.avg_days) : null,
    };
  });

  return c.json({
    success: true,
    data: {
      year,
      years: years.rows.map((r: any) => r.y),
      items,
      // Flags a data-freshness caveat the frontend should surface: commission
      // gates on invoice_status, which can lag until the next full resync
      // (see file header).
      invoiceStatusMayBeStale: true,
    },
  });
});

export default app;
