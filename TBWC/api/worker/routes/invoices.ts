/**
 * Invoices (QuickBooks) — read-only. Table public.qb_invoice, PK qb_invoice_id.
 * Populated by the QBWC pull (InvoiceQueryRq); the source of truth is QuickBooks,
 * so this module exposes list + detail only — nobody writes here.
 *
 * Admins see every invoice; everyone else sees their own plus every user
 * they manage's (public.user_manager, flat one level — see middleware.ts's
 * visibleRepListIds). Ownership is qb_invoice.sales_rep_list_id (migration
 * 033), taken straight off QB's SalesRepRef on InvoiceRet by the sync — no
 * join to the sales order, because InvoiceQueryRq is not sent with
 * IncludeLinkedTxns and linked_txn is '[]' on every row. ~350 of 7.8k
 * invoices carry no rep: invisible to non-admins, visible to admins.
 *
 * Not quite read-only any more: the AR tab's collection-tracking columns
 * (migration 118) are TBWC-owned and editable by a caller holding
 * invoice:write — see WRITABLE and the PUT at the bottom. Every QB-synced
 * column stays untouchable; the next pull would overwrite it anyway.
 *
 * Aging (days_past_due / total_past_due) is computed per row here rather than
 * stored — see DAYS_PAST_DUE below. ?days_past_due=N / ?days_past_due_max=M
 * bound how late an invoice is (both inclusive, either one optional), which is
 * how the AR Aging report (arAging.ts) drills into its 30–59 / 60–89 / 90+
 * bands.
 */
import { Hono } from 'hono';
import { Env, execQuery } from '../db';
import { AuthVariables, authenticateToken, requirePermission, visibleRepListIds } from '../middleware';
import { findAll, findById, update, whereFromQuery, likeFieldsFromSchema } from '../crud';
import { invoicesSchema, NOTICE_METHODS } from './invoicesSchema';
import { applyEmbeddedGrid } from '@meterit/framework-backend/api/base/childRows';
import { stripNonEditable } from '@meterit/framework-backend/api/base/permissions';
import { createDocument, storagePrefix } from '@meterit/framework-backend/api/base/documents';
import { buildDocumentPdf } from '../pdf/documentPdf';
import { toDocumentLines, invoiceDocumentHeader, sendDocumentEmail, lateInvoiceSubject, lateInvoiceBody, loadCompanySettings, buildDocumentEml } from '../pdf/documentEmail';
import { putObject } from '../storageAdmin';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_invoice';
const PK = 'qb_invoice_id';
const SEARCH = ['ref_number', 'customer_name'];
const LIKE_FIELDS = likeFieldsFromSchema(invoicesSchema);

// qb_invoice has no rep name of its own, only sales_rep_list_id (the QB
// SalesRepRef ListID) — join public.qb_sales_rep to surface it as `sales_rep`
// for the schema's read-only display field (see invoicesSchema.ts).
const SALES_REP_JOIN = `LEFT JOIN public.qb_sales_rep ON qb_sales_rep.list_id = "${TABLE}".sales_rep_list_id`;
/** Same join, for the three hand-written `i`-aliased queries below (GET
 *  /:id/pdf, sendInvoiceNoticeEmail) — a qualified "qb_invoice" reference
 *  isn't valid once the table carries an alias, so SALES_REP_JOIN's literal
 *  table name doesn't work there. */
const SALES_REP_JOIN_I = `LEFT JOIN public.qb_sales_rep ON qb_sales_rep.list_id = i.sales_rep_list_id`;
/**
 * Resolves the sales order an invoice was created from — the "S.O. No." and
 * "Job Name" boxes the invoice PDF needs (see migration 120's header
 * comment) — off i.linked_txn (migration 008's `[{txn_id,txn_type}]`,
 * populated once IncludeLinkedTxns was turned on; see invoice.ts). Only the
 * first linked SalesOrder: QB lets one invoice link back to more than one,
 * but TBWC's workflow is one order -> one invoice, and the PDF has room for
 * one S.O. number. LATERAL (not a plain join) because the sub-select needs
 * `i` in scope to read its own linked_txn.
 */
// Falls back to customer + PO when linked_txn is empty — same fallback
// orders.ts's latestInvoiceSerialNumbers() uses in the other direction, for
// the same reason: QB only started emitting LinkedTxn once IncludeLinkedTxns
// was added (migration 037), so an invoice synced before then — or one QB
// itself never recorded a link for — has nothing in linked_txn to match on.
const SO_LINK_JOIN_I = `LEFT JOIN LATERAL (
     SELECT so.ref_number, so.job_name
       FROM public.qb_sales_order so
      WHERE so.txn_id = (
              SELECT elem->>'txn_id' FROM jsonb_array_elements(COALESCE(i.linked_txn, '[]'::jsonb)) elem
               WHERE elem->>'txn_type' = 'SalesOrder' LIMIT 1
            )
         OR (nullif(btrim(i.po_number), '') IS NOT NULL
             AND so.customer_list_id = i.customer_list_id
             AND nullif(btrim(so.po_number), '') = nullif(btrim(i.po_number), ''))
      ORDER BY (so.txn_id = (
                  SELECT elem->>'txn_id' FROM jsonb_array_elements(COALESCE(i.linked_txn, '[]'::jsonb)) elem
                   WHERE elem->>'txn_type' = 'SalesOrder' LIMIT 1
                )) DESC
      LIMIT 1
   ) so_link ON true`;

/**
 * Aging, computed per row at query time rather than stored — "past due" moves
 * every midnight, so no column could hold it. One shared predicate behind both
 * expressions: an invoice is past due only while it still owes money
 * (balance_remaining > 0, the same open-balance test /receivables-summary and
 * the AR Aging report use) AND its due date is behind us. Anything else —
 * paid off, not yet due, or no due date in QB at all — comes back NULL rather
 * than 0, so a blank cell reads as "not past due" instead of "zero days late"
 * and NULLS LAST keeps those rows out of the way when sorting.
 *
 * `days_past_due` is whole days; `total_past_due` is the dollars behind those
 * days (the open balance, which is what AR actually chases — `total` includes
 * whatever has already been paid). See arAging.ts, which buckets the same
 * expression into 30+/60+/90+ and links here.
 */
const PAST_DUE_PREDICATE = `"${TABLE}".due_date IS NOT NULL
  AND COALESCE("${TABLE}".balance_remaining, 0) > 0
  AND "${TABLE}".due_date < CURRENT_DATE`;
const DAYS_PAST_DUE = `CASE WHEN ${PAST_DUE_PREDICATE} THEN (CURRENT_DATE - "${TABLE}".due_date)::int END`;
const TOTAL_PAST_DUE = `CASE WHEN ${PAST_DUE_PREDICATE} THEN "${TABLE}".balance_remaining END`;

const SELECT_FIELDS = `"${TABLE}".*, qb_sales_rep.name AS sales_rep,
  ${DAYS_PAST_DUE} AS days_past_due,
  ${TOTAL_PAST_DUE} AS total_past_due`;

/**
 * Customer contact, joined on the detail route only. The AR tab's notice
 * buttons hand these straight to the OS (mailto: / tel:), so chasing a past-due
 * invoice starts from the invoice instead of a detour through Customers.
 *
 * qb_invoice carries customer_name but no contact details — those live on
 * public.qb_customer, reached by the same customer_list_id avgDaysToPay uses.
 * Deliberately NOT in the list payload: no column shows them, and it would put
 * two contact strings on all 25 rows of every page for nothing. Read-only
 * either way — WRITABLE below can't reach them, and the next QB pull owns them.
 */
const CUSTOMER_JOIN = `LEFT JOIN public.qb_customer ON qb_customer.list_id = "${TABLE}".customer_list_id`;
const DETAIL_JOINS = `${SALES_REP_JOIN} ${CUSTOMER_JOIN}`;
const DETAIL_SELECT_FIELDS = `${SELECT_FIELDS},
  qb_customer.email AS customer_email,
  qb_customer.phone AS customer_phone`;

/**
 * Columns that only exist as a SELECT expression, and the SQL to sort them by.
 * findAll's own `sortBy` qualifies the column as "qb_invoice".<col>, which no
 * computed alias answers to (Postgres won't resolve a SELECT alias inside
 * ORDER BY once it's table-qualified) — so a click on one of these headers
 * becomes an explicit `orderBy` instead. `sales_rep` is in here for the same
 * reason: it's the joined rep name, not a qb_invoice column, and sorting on it
 * errored before this map existed.
 */
const COMPUTED_ORDER_BY: Record<string, string> = {
  days_past_due: DAYS_PAST_DUE,
  total_past_due: TOTAL_PAST_DUE,
  sales_rep: 'qb_sales_rep.name',
};

/**
 * The only columns a PUT may touch — the AR tab's TBWC-owned collection
 * tracking (migration 118). Everything else on qb_invoice is QuickBooks', and
 * the next QBWC pull would overwrite a direct edit anyway, so an allowlist
 * (not a denylist) keeps a new QB column from silently becoming writable the
 * day it's added. Same shape as orders.ts's WRITABLE.
 */
const WRITABLE = new Set([
  'notice_1_date', 'notice_1_method', 'notice_1_note',
  'notice_2_date', 'notice_2_method', 'notice_2_note',
  'notice_3_date', 'notice_3_method', 'notice_3_note',
  'ar_notes',
  'late_fee_applied',
]);

const METHOD_FIELDS = new Set(['notice_1_method', 'notice_2_method', 'notice_3_method']);

/**
 * Average days this customer takes to pay, derived — NOT synced. QuickBooks
 * shows an "Average Days to Pay" in its Customer Center that qbXML never
 * sends (CustomerQueryRq returns no such field, verified against every synced
 * customer), so it's computed here from the payments QB *does* send: for each
 * of the customer's paid invoices, the days from invoice date to the first
 * payment applied to it (qb_payment.applied_to carries the invoice's txn_id),
 * averaged.
 *
 * Negative spans are dropped: a payment applied before the invoice date is a
 * prepayment being drawn down, not fast payment, and would drag the average
 * below what the customer actually does. Null when the customer has never
 * paid an invoice — a customer with no history has no average, which is not
 * the same as paying in zero days.
 *
 * Detail route only (~9ms); the list would run it per row.
 */
async function avgDaysToPay(env: Env, customerListId: string | null): Promise<number | null> {
  if (!customerListId) return null;
  const { rows } = await execQuery(
    env,
    `WITH pay AS (
       SELECT (a->>'txn_id') AS inv_txn_id, p.txn_date AS paid_date
         FROM public.qb_payment p
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p.applied_to, '[]'::jsonb)) a
        WHERE a->>'txn_type' = 'Invoice'
          AND p.txn_date IS NOT NULL
     ),
     paid AS (
       SELECT (MIN(pay.paid_date) - i.txn_date)::int AS days
         FROM public.qb_invoice i
         JOIN pay ON pay.inv_txn_id = i.txn_id
        WHERE i.customer_list_id = $1
          AND i.qb_deleted_at IS NULL
          AND NOT i.is_packing_slip
          AND i.txn_date IS NOT NULL
        GROUP BY i.qb_invoice_id, i.txn_date
     )
     SELECT round(avg(days))::int AS adp FROM paid WHERE days >= 0`,
    [customerListId],
    'invoices.avgDaysToPay'
  );
  const adp = rows[0]?.adp;
  return adp === null || adp === undefined ? null : Number(adp);
}

/**
 * The caller's visible rep list_ids (own + every managed user's — see
 * middleware.ts's visibleRepListIds), or null when their invoice:read grant
 * covers every row. An own-scoped caller with no linked qb_sales_rep and no
 * managed users gets `[]`, which matches nothing, rather than an IS NULL
 * scope that would hand them every invoice with no linked rep yet (mirrors
 * orders.ts).
 *
 * No field redaction here on purpose: reps see every column on the invoices
 * that are theirs — totals, balance and paid status included.
 */
function repScope(c: any): string[] | null {
  return c.get('permissions').scopeOf('invoice:read') === 'own'
    ? visibleRepListIds(c.get('user'))
    : null;
}

app.get('/', requirePermission('invoice:read'), async (c) => {
  const q = c.req.query();
  // txn_date_from/txn_date_to aren't real columns — they drive the whereRange
  // bound below (the Invoice Totals report's card drill-down links here with
  // them), so keep whereFromQuery from treating them as an exact-match field.
  // days_past_due/total_past_due aren't columns either (SELECT expressions):
  // days_past_due and days_past_due_max become the bounds just below, and
  // total_past_due is reserved so a stray query param can't reach SQL as a
  // column comparison.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, {
    likeFields: LIKE_FIELDS,
    extraReserved: ['txn_date_from', 'txn_date_to', 'days_past_due', 'days_past_due_max', 'total_past_due'],
  });
  // Field filters first, then the scope — it always wins, so a rep can't widen
  // their own visibility with a crafted sales_rep_list_id query param. An
  // IN-list, not a single exact match, so it goes through whereRaw rather
  // than `where` (see orders.ts for the same pattern/rationale).
  const scope = repScope(c);
  const where: Record<string, any> = {
    ...fieldWhere,
    // Deleted in QB (see qbwc/objects/txnDeleted.ts) — kept for the order module's
    // history, never shown as a live invoice.
    qb_deleted_at: null,
  };
  const whereRaw: { sql: string; params?: any[] }[] = scope === null
    ? []
    : [scope.length > 0
        ? { sql: `sales_rep_list_id IN (${scope.map(() => '?').join(', ')})`, params: scope }
        : { sql: '1 = 0' }];
  // ?days_past_due / ?days_past_due_max are inclusive *bounds*, not exact
  // matches: they're the AR Aging report's drill-down (30–59, 60–89, 90+), and
  // "exactly 47 days late" is not a question anyone asks. Either may be given
  // alone. NULL rows (paid or not yet due) drop out on their own — a NULL
  // comparison is never true.
  const minDaysPastDue = parseInt(q.days_past_due ?? '', 10);
  if (Number.isFinite(minDaysPastDue)) {
    whereRaw.push({ sql: `(${DAYS_PAST_DUE}) >= ?`, params: [minDaysPastDue] });
  }
  const maxDaysPastDue = parseInt(q.days_past_due_max ?? '', 10);
  if (Number.isFinite(maxDaysPastDue)) {
    whereRaw.push({ sql: `(${DAYS_PAST_DUE}) <= ?`, params: [maxDaysPastDue] });
  }
  // A computed column's header click can't go through findAll's sortBy — see
  // COMPUTED_ORDER_BY. Falls back to newest-invoice-first when nothing is sorted.
  const computedSort = q.sortBy ? COMPUTED_ORDER_BY[q.sortBy] : undefined;
  const sortDir = (q.sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: SEARCH,
    sortBy: computedSort ? undefined : q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: computedSort
      ? `${computedSort} ${sortDir} NULLS LAST`
      : q.sortBy ? undefined : `"${TABLE}".txn_date DESC`,
    where,
    whereLike,
    whereRaw,
    whereRange: (q.txn_date_from || q.txn_date_to)
      ? { txn_date: { gte: q.txn_date_from || undefined, lte: q.txn_date_to || undefined } }
      : undefined,
    // Packing slips aren't real invoices — never list them (migration 066:
    // keyed off QB's own TemplateRef, not total=0 — a real invoice can be
    // zero-total too).
    whereNot: { is_packing_slip: true },
    joins: SALES_REP_JOIN,
    selectFields: SELECT_FIELDS,
  });
  const items = result.rows.map((r: any) => applyEmbeddedGrid(c.get('permissions'), 'invoiceGridLine', 'lines', r));
  return c.json({ success: true, data: { items, total: result.pagination.total } });
});

// Company-wide AR total for a year. No frontend caller right now — the
// dashboard's "Total Receivables" card it was built for has been removed;
// kept because it's the one scoped, exact AR total the API exposes (the AR
// Aging report answers a different question), so anything that needs the
// figure next should reuse it rather than re-derive one.
// A dedicated SUM rather than the client-side
// bulk-fetch-and-reduce pattern the other dashboard cards use — this is a
// real financial total, not a rough KPI, and ~7.8k invoices company-wide is
// enough that a truncated client page could silently under-count it.
// ?year=YYYY selects the year (default: current); `years` in the response is
// every year actually present in qb_invoice.txn_date, for the dropdown's
// options — computed here rather than client-side because this route never
// fetches the underlying rows.
app.get('/receivables-summary', requirePermission('invoice:read'), async (c) => {
  const scope = repScope(c);
  const yearParam = parseInt(c.req.query('year') ?? '', 10);
  const year = Number.isFinite(yearParam) ? yearParam : new Date().getFullYear();

  const { rows } = await execQuery(
    c.env,
    `SELECT COALESCE(SUM(balance_remaining), 0)::numeric AS total, COUNT(*)::int AS count
       FROM public.qb_invoice
      WHERE qb_deleted_at IS NULL
        AND COALESCE(balance_remaining, 0) > 0
        AND extract(year FROM txn_date)::int = $2
        AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))`,
    [scope, year],
    'invoices.receivablesSummary'
  );
  const { rows: yearRows } = await execQuery(
    c.env,
    `SELECT DISTINCT extract(year FROM txn_date)::int AS y
       FROM public.qb_invoice
      WHERE qb_deleted_at IS NULL AND txn_date IS NOT NULL
        AND ($1::text[] IS NULL OR sales_rep_list_id = ANY($1::text[]))
      ORDER BY y DESC`,
    [scope],
    'invoices.receivablesSummary.years'
  );
  return c.json({
    success: true,
    data: {
      total: Number(rows[0]?.total ?? 0),
      count: rows[0]?.count ?? 0,
      year,
      years: yearRows.map((r: any) => r.y),
    },
  });
});

/**
 * True when the caller may reach this invoice under `permission` — an 'own'
 * scope is checked against the caller's visible rep list_ids (own + every
 * managed user's), an unlinked rep matching nothing. Shared by
 * denyUnlessVisible (GET/PUT) and sendInvoiceNoticeEmail (the notice-email
 * routes below), so all four can never disagree about who owns a row.
 */
function invoiceVisible(c: any, row: any, permission: 'invoice:read' | 'invoice:write'): boolean {
  const scope = c.get('permissions').scopeOf(permission) === 'own'
    ? visibleRepListIds(c.get('user'))
    : null;
  return scope === null || (!!row.sales_rep_list_id && scope.includes(row.sales_rep_list_id));
}

/**
 * The caller may see this invoice: null when they may, or the 404 response
 * when they may not. 404 rather than 403 — a rep shouldn't be able to probe
 * which invoice ids exist.
 */
function denyUnlessVisible(c: any, row: any, permission: 'invoice:read' | 'invoice:write') {
  return invoiceVisible(c, row, permission) ? null : c.json({ success: false, message: 'Invoice not found' }, 404);
}

/**
 * A collection notice slot (1/2/3) is immutable once an email actually went
 * out for it (sendInvoiceNoticeEmail below stamps method='email') — so the
 * record of "we emailed this" can't be quietly edited after the fact. A
 * phone-logged notice (method='phone') stays freely editable, same as
 * before: nothing sends/documents it, so there's nothing to protect.
 */
function noticeLocked(existing: any, n: number): boolean {
  return existing[`notice_${n}_method`] === 'email' && existing[`notice_${n}_date`] != null;
}

/** First notice slot (1/2/3) this invoice hasn't sent yet, or null once all
 *  three have a date (regardless of method — a slot is "used" either way). */
function nextNoticeSlot(row: any): 1 | 2 | 3 | null {
  for (const n of [1, 2, 3] as const) {
    if (!row[`notice_${n}_date`]) return n;
  }
  return null;
}

/** Thrown by sendInvoiceNoticeEmail; the two routes below map it to this status. */
class NoticeEmailError extends Error {
  constructor(message: string, public status: 400 | 404 | 502 = 400) {
    super(message);
  }
}

/** Every AR collection-notice email (single or bulk) also Ccs accounting —
 *  the human inbox that fields customer replies/disputes on these. */
const AR_NOTICE_CC = 'accounting@tbwcinc.com';

/**
 * The AR tab's "Email notice" action — single-row (POST /:id/notice-email)
 * and the AR Aging report's row-checkbox bulk send (POST
 * /notice-email/bulk) both call this, so there is exactly one path that
 * sends a collection notice, locks it, and records it. Previously the AR
 * tab's Email button only opened the OS mail client (mailto:/share-sheet) —
 * no server record, nothing to lock, nothing attached — which is the gap
 * this closes: a real send (this Worker's own mail pipeline, see
 * documentEmail.ts), a locked notice_N_date/method, and a document row with
 * the sent PDF for an audit trail.
 *
 * `sentDate` is the caller's own local calendar date (YYYY-MM-DD), the same
 * way noticeActions.ts's todayLocal() works on the frontend — this Worker
 * runs in UTC, and "today" for a notice is the sender's day, not UTC's
 * (someone sending after ~4-5pm Pacific would otherwise get stamped
 * tomorrow). Falls back to the Worker's own UTC date only if the caller
 * omits it.
 *
 * `notice` (1/2/3) is which slot to send: the AR tab's per-section buttons
 * pass the section the sender actually clicked (so clicking "3rd Notice"
 * sends #3 even if #2 is still open, same freedom the old mailto buttons
 * gave), while the AR Aging report's bulk send has no section to read a
 * choice off and leaves this unset to auto-pick the next never-sent slot
 * (nextNoticeSlot). Either way, a slot an email already locked is refused.
 */
async function sendInvoiceNoticeEmail(
  c: any,
  id: string,
  opts: { sentDate?: string; notice?: number } = {}
): Promise<{ notice: number; recipient: string; refNumber: string | null; documented: boolean }> {
  const { rows } = await execQuery(
    c.env,
    `SELECT i.ref_number, i.customer_name, i.txn_date, i.due_date, i.ship_date, i.total, i.subtotal,
            i.balance_remaining, i.lines, i.sales_rep_list_id, i.po_number, i.terms, i.ship_via, i.fob,
            i.bill_address_block, i.ship_address_block, i.sales_tax_total, i.sales_tax_percent,
            i.freight_acct_zip,
            i.notice_1_date, i.notice_1_method, i.notice_2_date, i.notice_2_method,
            i.notice_3_date, i.notice_3_method,
            c.bill_addr, c.email AS customer_email,
            qb_sales_rep.initial AS sales_rep, so_link.ref_number AS so_ref_number, so_link.job_name
       FROM public.qb_invoice i
       LEFT JOIN public.qb_customer c ON c.list_id = i.customer_list_id
       ${SALES_REP_JOIN_I}
       ${SO_LINK_JOIN_I}
      WHERE i.${PK} = $1 AND i.qb_deleted_at IS NULL`,
    [id],
    'invoices.loadForNotice'
  );
  const row = rows[0];
  if (!row) throw new NoticeEmailError('Invoice not found', 404);
  if (!invoiceVisible(c, row, 'invoice:write')) throw new NoticeEmailError('Invoice not found', 404);

  const notice = [1, 2, 3].includes(opts.notice as number) ? (opts.notice as 1 | 2 | 3) : nextNoticeSlot(row);
  if (notice === null) throw new NoticeEmailError('All 3 collection notices have already been sent for this invoice', 400);
  if (noticeLocked(row, notice)) throw new NoticeEmailError(`Notice ${notice} was already emailed`, 400);

  const recipient = row.customer_email;
  if (!recipient) throw new NoticeEmailError('No email on file for this customer', 400);

  const caller = c.get('user');
  const subject = lateInvoiceSubject(row.ref_number);
  const message = lateInvoiceBody({ customerName: row.customer_name });
  const replyTo = caller?.email || undefined;
  const company = await loadCompanySettings(c.env);

  try {
    await sendDocumentEmail(c.env, invoiceDocumentHeader(row, company), toDocumentLines(row.lines), recipient, { message, subject, replyTo, cc: AR_NOTICE_CC, hideLogo: true });
  } catch (e: any) {
    throw new NoticeEmailError(e?.message || 'Failed to send email', 502);
  }

  // The email is already out at this point — a failure from here on is
  // logged, not surfaced, so a storage/document hiccup can't make a notice
  // that actually went out read back as a failed send.
  let documented = false;
  try {
    // .eml, not a bare PDF — the stored copy is the whole sent message (From/
    // To/Subject/body) with the invoice PDF attached inside it, so opening it
    // from the Documents grid launches Outlook (or whatever handles .eml) and
    // shows exactly what the customer received, not just the attachment.
    const { bytes: emlBytes } = await buildDocumentEml(
      invoiceDocumentHeader(row, company), toDocumentLines(row.lines), recipient, { message, subject, replyTo, cc: AR_NOTICE_CC, hideLogo: true }
    );
    const path = `${storagePrefix('invoice', id)}ar-notice-${notice}-${Date.now()}.eml`;
    await putObject(c.env, 'record-docs', path, emlBytes, 'message/rfc822');
    await createDocument(execQuery, c.env, {
      entityType: 'invoice',
      entityId: id,
      fileName: `AR-Notice-${notice}-${row.ref_number || id}.eml`,
      storageBucket: 'record-docs',
      storagePath: path,
      docType: 'email',
      mimeType: 'message/rfc822',
      fileSize: emlBytes.length,
      description: `Collection notice ${notice} emailed to ${recipient}`,
      createdBy: c.get('userId'),
    });
    documented = true;
  } catch (e) {
    console.error('[invoices] notice-email document record failed:', e instanceof Error ? e.message : e);
  }

  await update(c.env, TABLE, PK, id, {
    [`notice_${notice}_date`]: opts.sentDate || new Date().toISOString().slice(0, 10),
    [`notice_${notice}_method`]: 'email',
  }, { touchUpdatedAt: false });

  return { notice, recipient, refNumber: row.ref_number, documented };
}

app.get('/:id', requirePermission('invoice:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'), undefined, DETAIL_SELECT_FIELDS, DETAIL_JOINS);
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Invoice not found' }, 404);
  const denied = denyUnlessVisible(c, row, 'invoice:read');
  if (denied) return denied;
  // Derived, not stored — one aggregate per open of the form (see avgDaysToPay).
  row.avg_days_to_pay = await avgDaysToPay(c.env, row.customer_list_id);
  return c.json({ success: true, data: applyEmbeddedGrid(c.get('permissions'), 'invoiceGridLine', 'lines', row) });
});

/**
 * The invoice as a PDF — the same builder (pdf-lib, see pdf/documentPdf.ts)
 * and header mapping (pdf/documentEmail.ts's invoiceDocumentHeader) as the AI
 * chat's email_invoice tool, so this is exactly the document that tool would
 * have sent. Gated on invoice:read, not :write: generating it mutates
 * nothing, and a caller who can see the invoice can see this rendering of it.
 *
 * Generic PDF rendering of an invoice — the notice-email send itself
 * (sendInvoiceNoticeEmail below) builds and attaches its own copy
 * server-side rather than fetching this route, so this stays available for
 * any other "view/print this invoice" need without being load-bearing for
 * the AR tab.
 */
app.get('/:id/pdf', requirePermission('invoice:read'), async (c) => {
  const id = c.req.param('id');
  const { rows } = await execQuery(
    c.env,
    `SELECT i.ref_number, i.customer_name, i.txn_date, i.due_date, i.ship_date, i.total, i.subtotal,
            i.balance_remaining, i.lines, i.sales_rep_list_id, i.po_number, i.terms, i.ship_via, i.fob,
            i.bill_address_block, i.ship_address_block, i.sales_tax_total, i.sales_tax_percent,
            i.freight_acct_zip,
            c.bill_addr,
            qb_sales_rep.initial AS sales_rep, so_link.ref_number AS so_ref_number, so_link.job_name
       FROM public.qb_invoice i
       LEFT JOIN public.qb_customer c ON c.list_id = i.customer_list_id
       ${SALES_REP_JOIN_I}
       ${SO_LINK_JOIN_I}
      WHERE i.${PK} = $1 AND i.qb_deleted_at IS NULL`,
    [id],
    'invoices.loadForPdf'
  );
  const row = rows[0];
  if (!row) return c.json({ success: false, message: 'Invoice not found' }, 404);
  const denied = denyUnlessVisible(c, row, 'invoice:read');
  if (denied) return denied;
  const company = await loadCompanySettings(c.env);
  const pdfBytes = await buildDocumentPdf(invoiceDocumentHeader(row, company), toDocumentLines(row.lines));
  // pdf-lib's Uint8Array return type doesn't pin its buffer to plain
  // ArrayBuffer (vs. ArrayBufferLike/SharedArrayBuffer), which current DOM
  // lib typings want for BlobPart — it's never actually shared memory here
  // (same cast orders.ts's GET /:id/email/pdf already carries).
  return new Response(new Blob([pdfBytes as BlobPart]), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="Invoice-${row.ref_number || id}.pdf"`,
    },
  });
});

/**
 * Email one collection notice for ONE invoice — the AR tab's per-section
 * Email-notice button. `notice` is which section the sender clicked (the AR
 * tab always sends it); omitted, this auto-picks the next never-sent slot
 * instead, same as the bulk route below. See sendInvoiceNoticeEmail above
 * for what this actually does (send, lock, document); this route is just
 * its HTTP/permission wrapper.
 */
app.post('/:id/notice-email', requirePermission('invoice:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  try {
    const result = await sendInvoiceNoticeEmail(c, c.req.param('id'), {
      sentDate: typeof body.sentDate === 'string' ? body.sentDate : undefined,
      notice: [1, 2, 3].includes(body.notice) ? body.notice : undefined,
    });
    return c.json({ success: true, data: result });
  } catch (e: any) {
    if (e instanceof NoticeEmailError) return c.json({ success: false, message: e.message }, e.status);
    throw e;
  }
});

/**
 * The AR Aging report's row-checkbox "Email" action — the same send as
 * above, for however many invoices (1 or many) are selected. Sequential, not
 * Promise.all: each send is already a PDF build + an outbound email + a
 * storage write + two DB writes, and the past-due book is selected a page at
 * a time anyway, never all ~130 rows at once. Per-invoice result rather than
 * failing the whole batch on one bad row — a customer with no email on file
 * shouldn't stop every other selected invoice from being notified.
 */
app.post('/notice-email/bulk', requirePermission('invoice:write'), async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const ids: string[] = Array.isArray(body.invoiceIds) ? body.invoiceIds.map(String).filter(Boolean) : [];
  if (ids.length === 0) return c.json({ success: false, message: 'invoiceIds is required' }, 400);
  const sentDate = typeof body.sentDate === 'string' ? body.sentDate : undefined;

  const results: { id: string; success: boolean; message?: string; notice?: number; recipient?: string }[] = [];
  for (const id of ids) {
    try {
      const result = await sendInvoiceNoticeEmail(c, id, { sentDate });
      results.push({ id, success: true, notice: result.notice, recipient: result.recipient });
    } catch (e: any) {
      results.push({ id, success: false, message: e instanceof NoticeEmailError ? e.message : (e?.message || 'Failed to send') });
    }
  }
  return c.json({ success: true, data: { results } });
});

/**
 * AR tab edits. The only write on this module: WRITABLE above is the hard
 * limit on what a PUT can ever reach, and stripNonEditable narrows that again
 * to what THIS caller's role may edit (role_permission.field_access). Anything
 * else in the body — a QB column, a computed alias, the primary key — is
 * dropped silently rather than 400'd, same as orders.ts, so a form POSTing its
 * whole entity back doesn't need to know the split.
 */
app.put('/:id', requirePermission('invoice:write'), async (c) => {
  const id = c.req.param('id');
  const existing = await findById(c.env, TABLE, PK, id);
  if (!existing || existing.qb_deleted_at) return c.json({ success: false, message: 'Invoice not found' }, 404);
  const denied = denyUnlessVisible(c, existing, 'invoice:write');
  if (denied) return denied;

  const body = stripNonEditable(c.get('permissions'), 'invoice:write', await c.req.json().catch(() => ({})));
  const data: Record<string, any> = {};
  for (const [k, v] of Object.entries(body)) {
    if (!WRITABLE.has(k)) continue;
    // A notice slot an email already went out for is immutable — see
    // noticeLocked. Silently dropped, same treatment as every other field
    // this caller may not touch, rather than 400ing a form that simply
    // POSTed back what it was given.
    const noticeField = /^notice_([123])_(?:date|method)$/.exec(k);
    if (noticeField && noticeLocked(existing, Number(noticeField[1]))) continue;
    // The method dropdown's values are a closed set (invoicesSchema.ts's
    // NOTICE_METHODS) — reject rather than store something the form can't
    // render back. Empty/null clears the field.
    if (METHOD_FIELDS.has(k) && v !== null && v !== '' && !NOTICE_METHODS.includes(v as any)) {
      return c.json({ success: false, message: `Invalid ${k}: ${v}` }, 400);
    }
    // '' from an emptied form control means "clear it" for every nullable
    // column here; late_fee_applied is NOT NULL, so it coerces to false instead.
    data[k] = k === 'late_fee_applied' ? v === true || v === 'true' : (v === '' ? null : v);
  }
  if (Object.keys(data).length > 0) {
    await update(c.env, TABLE, PK, id, data, { touchUpdatedAt: false });
  }

  const row = await findById(c.env, TABLE, PK, id, undefined, DETAIL_SELECT_FIELDS, DETAIL_JOINS);
  row.avg_days_to_pay = await avgDaysToPay(c.env, row.customer_list_id);
  return c.json({ success: true, data: applyEmbeddedGrid(c.get('permissions'), 'invoiceGridLine', 'lines', row) });
});

export default app;
