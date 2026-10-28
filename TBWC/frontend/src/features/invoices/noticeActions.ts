/**
 * The AR tab's notice buttons (see InvoiceForm): reading a notice section
 * name back to its slot number, today's date in the sender's own timezone,
 * and turning a QB phone number into a dialable `tel:` link.
 *
 * The Email button itself no longer builds anything here — the send is
 * server-side now (routes/invoices.ts's sendInvoiceNoticeEmail), which is
 * also where the notice subject/body copy lives (pdf/documentEmail.ts's
 * lateInvoiceSubject/lateInvoiceBody). Phone has no server-side equivalent
 * (nothing to send, nothing to attach), so `tel:` stays a client-side link.
 *
 * Pure functions, separate from the form, because a wrong answer here is
 * invisible until someone's dialer doesn't open — so they're unit-tested
 * rather than eyeballed.
 */

/** 'Nth Notice' → N. The AR tab's three notice sections (invoicesSchema.ts)
 *  are the only ones that get contact buttons; anything else is null. */
export function noticeNumberOf(sectionName: string): number | null {
  const m = /^([123])(?:st|nd|rd) Notice$/.exec(sectionName);
  return m ? Number(m[1]) : null;
}

/**
 * Today as YYYY-MM-DD in the *user's* timezone, which is what a date input
 * reads back and what the Worker stores in a `date` column. Deliberately not
 * `toISOString().slice(0, 10)` (the shortcut used elsewhere in this app): that
 * is UTC, so after 4-5pm Pacific it stamps tomorrow — and "when did we send
 * the notice" is answered by the sender's calendar, not UTC's.
 */
export function todayLocal(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/**
 * `tel:` for the customer, which Windows hands to the registered telephony
 * app (Phone Link). Digits only — qb_customer phones arrive as
 * '(951) 271-8200', '951-683-6625' and '909 974 0111' alike (same rule as the
 * framework's PhoneLink). Under 10 digits is an extension or junk, not
 * dialable, so it comes back null and the button is disabled.
 */
export function telHrefFor(phone: string | null | undefined): string | null {
  const digits = (phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? `tel:${digits}` : null;
}
