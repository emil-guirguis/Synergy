/**
 * Serial numbers for an order, pulled out of its invoice's line descriptions.
 *
 * This company's QuickBooks file has no serial/lot tracking, so staff type
 * serials straight into a line's Desc by hand, mixed in with the rest of that
 * line's product description. The shapes that actually occur in the live data
 * (checked across every invoice that mentions "serial"):
 *
 *   "... Modbus IP.\n\nSerial #: P032609156"
 *   "... (1)VR.xx\nMeter Serial #s: P122607060, P122607056"
 *   "... PROTON SERIAL # PR0007948"
 *   "... METER SERIAL # / PASSWORD\nP032508495 / 890G\nP032508478 / ZSLF"
 *   "... Serial # and Password:\nP032503100     SIZI"
 *
 * So: find the marker, then take every serial-shaped token after it. Two
 * traps, both real in the data —
 *   - "Modbus Serial or IP", "Serial Modbus and BACnet Communications" are
 *     protocol names on hundreds of lines, never serials. Hence the marker
 *     insists on numbers?/nos?/# right after the word.
 *   - the same desc often ends with a shipping block ("Tracking:\n1ZK6B20...").
 *     Those numbers belong to shipping_tracking, not here, so the tail is cut
 *     at the tracking marker before tokens are read.
 * Passwords are deliberately not extracted: they sit beside the serial in the
 * same text and are visible on the Line Items tab, but a serial list is what
 * the tab is for.
 *
 * Tokens are 1-3 letters + 5-12 digits ("P032609156", "PR0007948",
 * "XC2503098"), which is every serial in the file plus the typos staff made
 * entering them (e.g. "P32606298", a digit short) — kept verbatim, since the
 * typo IS what is printed on the meter's label as far as this record knows.
 * Part numbers in the same text don't match the shape ("DIPS3HD-C-D-N",
 * "WC1-100-MV333", "G201608C" all fail it).
 */

/** One invoice line that carries at least one serial. */
export interface OrderSerialLine {
  /** QB item code, e.g. "DI-MMU16-N1-(2)VR.xx". */
  item: string | null;
  /** The line's full Desc, so staff can see which unit a serial belongs to. */
  desc: string | null;
  serials: string[];
}

/** What GET /api/orders/:id hands the form's Serial Numbers tab. */
export interface OrderSerials {
  /** The invoice the serials were read off, for the tab's caption. */
  invoice_ref: string | null;
  invoice_date: string | null;
  items: OrderSerialLine[];
}

/** 'serial' alone is a protocol name here — a number word or # has to follow. */
const SERIAL_MARKER = /serial\s*(?:numbers?|nos?\b|#)/i;
/** Shipping numbers live in the same desc; they are not serials. */
const TRACKING_MARKER = /tracking/i;
const SERIAL_TOKEN = /\b[A-Z]{1,3}\d{5,12}\b/g;

/** Serials in one line's Desc, in the order typed, deduped. */
export function serialsFromDesc(desc: string | null | undefined): string[] {
  if (!desc) return [];
  const marker = SERIAL_MARKER.exec(desc);
  if (!marker) return [];
  let tail = desc.slice(marker.index);
  const tracking = TRACKING_MARKER.exec(tail);
  if (tracking) tail = tail.slice(0, tracking.index);
  return [...new Set(tail.toUpperCase().match(SERIAL_TOKEN) ?? [])];
}

/**
 * The serial block for one invoice row (ref_number/txn_date/lines as the
 * qb_invoice columns hold them). Lines with no serials are dropped — the tab
 * lists serials, not the whole invoice, which the Invoices panel already opens.
 */
export function extractOrderSerials(
  invoice: { ref_number?: string | null; txn_date?: string | null; lines?: unknown } | null | undefined
): OrderSerials | null {
  if (!invoice) return null;
  const lines = Array.isArray(invoice.lines) ? (invoice.lines as any[]) : [];
  const items: OrderSerialLine[] = [];
  for (const line of lines) {
    const serials = serialsFromDesc(line?.desc);
    if (serials.length) items.push({ item: line?.item ?? null, desc: line?.desc ?? null, serials });
  }
  return {
    invoice_ref: invoice.ref_number ?? null,
    invoice_date: invoice.txn_date ?? null,
    items,
  };
}
