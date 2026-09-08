/**
 * qbXML helpers shared by object modules.
 *
 * qbXML is the payload QuickBooks Desktop speaks: an XML doc wrapped in a
 * <?qbxml?> processing instruction and a <QBXML><QBXMLMsgsRq>…</> body. Each
 * request carries a requestID we echo back in the response so we can route it to
 * the right parser. We hand-extract fields (same rationale as soap.ts: no XML
 * lib needed for these shallow, well-known shapes).
 */

/** qbXML version negotiated with QB. 13.0 covers QB 2015+; safe broad default. */
export const QBXML_VERSION = '13.0';

/** Timezone of the QuickBooks Desktop machine (SVR2012). QB stores/returns
 *  TimeModified in this local zone; incremental FromModifiedDate must match it. */
export const QB_TIMEZONE = 'America/Los_Angeles';

/**
 * Render a UTC instant as a qbXML dateTime in QB's local zone WITH an explicit
 * offset (YYYY-MM-DDThh:mm:ss±hh:mm). We store QB's TimeModified as UTC in
 * Postgres; when we send it back as FromModifiedDate, a bare (offset-less) value
 * is read by QB as ITS local time, shifting the incremental window by the whole
 * UTC offset. Emitting the local wall-clock plus the offset removes the ambiguity.
 */
export function toQbLocal(utc: string | Date, tz: string = QB_TIMEZONE): string {
  const d = typeof utc === 'string' ? new Date(utc) : utc;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const { type, value } of fmt.formatToParts(d)) p[type] = value;
  const hh = p.hour === '24' ? '00' : p.hour; // some ICU builds emit 24 at midnight
  // Offset = (same wall-clock read as UTC) - (actual instant).
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +hh, +p.minute, +p.second);
  const offMin = Math.round((asUtc - d.getTime()) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  const oh = String(Math.floor(abs / 60)).padStart(2, '0');
  const om = String(abs % 60).padStart(2, '0');
  return `${p.year}-${p.month}-${p.day}T${hh}:${p.minute}:${p.second}${sign}${oh}:${om}`;
}

/** Wrap one or more *Rq fragments in a full qbXML document. */
export function qbxmlDoc(inner: string, onError: 'stopOnError' | 'continueOnError' = 'continueOnError'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<?qbxml version="${QBXML_VERSION}"?>
<QBXML>
  <QBXMLMsgsRq onError="${onError}">
${inner}
  </QBXMLMsgsRq>
</QBXML>`;
}

/** First direct child text of <tag> within `scope` (namespace-agnostic), unescaped. */
export function tag(scope: string, name: string): string | undefined {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`);
  const m = scope.match(re);
  return m ? unescapeXml(m[1]) : undefined;
}

/** All top-level <name>…</name> blocks within `scope` (non-nested same-name safe for QB rets). */
export function blocks(scope: string, name: string): string[] {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(scope)) !== null) out.push(m[1]);
  return out;
}

/** Read the statusCode attribute of a *Rs response element. */
export function statusCode(scope: string, rsName: string): string | undefined {
  const re = new RegExp(`<${rsName}\\b[^>]*\\bstatusCode="([^"]*)"`);
  const m = scope.match(re);
  return m ? m[1] : undefined;
}

/** Max objects QB returns per iterator page for large Query pulls. */
export const QB_MAX_RETURNED = 500;

/**
 * If a *Rs element carries iteratorRemainingCount > 0, there's more of this
 * query's result set still on the QB side (a single un-iterated QueryRq can be
 * silently capped by QB at its own response-size ceiling). Returns the pieces
 * needed to build a `Continue` request, or undefined if fully returned.
 */
export function pendingIterator(responseXml: string): { rqName: string; requestID: string; iteratorId: string } | undefined {
  // Scan every *Rs opening tag (the payload is wrapped in <QBXMLMsgsRs>, which
  // never carries iterator attrs, so matching only the first tag finds nothing).
  // Attribute order isn't guaranteed, so pull each attr out independently.
  const rsTags = responseXml.matchAll(/<([A-Za-z]+)Rs\b([^>]*)>/g);
  for (const [, base, attrs] of rsTags) {
    const remaining = attrs.match(/\biteratorRemainingCount="(\d+)"/)?.[1];
    if (!remaining || Number(remaining) <= 0) continue;
    const requestID = attrs.match(/\brequestID="([^"]*)"/)?.[1];
    const iteratorId = attrs.match(/\biteratorID="([^"]*)"/)?.[1];
    if (!requestID || !iteratorId) continue;
    return { rqName: `${base}Rq`, requestID, iteratorId };
  }
  return undefined;
}

/**
 * Build the qbXML doc that asks QB for the next page of a prior iterated query.
 * `extraInner` re-states non-filter options the object needs on every page
 * (e.g. IncludeLineItems — omitted, continuation pages come back without lines).
 */
export function iteratorContinueDoc(rqName: string, requestID: string, iteratorId: string, extraInner = ''): string {
  return qbxmlDoc(
    `    <${rqName} requestID="${requestID}" iterator="Continue" iteratorID="${escapeXml(iteratorId)}">\n` +
    `      <MaxReturned>${QB_MAX_RETURNED}</MaxReturned>\n${extraInner}    </${rqName}>`
  );
}

export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** QB TimeModified is ISO-8601 with offset; return a value Postgres accepts, or null. */
export function qbTimeToTs(v: string | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/** QB's FromModifiedDate filter is inclusive (>=), and TimeModified granularity
 *  is whole seconds — so the last record we stored (time_modified == our "since"
 *  boundary) matches again on every subsequent poll. Bump by 1s to exclude it. */
export function bumpSecond(iso: string): string {
  return new Date(new Date(iso).getTime() + 1000).toISOString();
}

/** Bare <FromModifiedDate> filter for LIST queries (Customer/SalesRep/Item) —
 *  qbXML requires this AFTER <ActiveStatus> in these schemas, never wrapped in
 *  <ModifiedDateRangeFilter> (that wrapper is transaction-only; using it on a
 *  list query makes QB reject the whole request with 0x80040400). '' when
 *  `sinceIso` is null (first run — full pull). */
export function listModifiedFilter(sinceIso: string | null): string {
  if (!sinceIso) return '';
  return `\n      <FromModifiedDate>${escapeXml(toQbLocal(bumpSecond(sinceIso)))}</FromModifiedDate>`;
}

/** <ModifiedDateRangeFilter> filter for TRANSACTION queries (SalesOrder,
 *  Invoice, Payment, Estimate). Same offset/bump handling as
 *  listModifiedFilter — a bare FromModifiedDate here is read in QB's local
 *  time with no offset, silently shifting the incremental window. '' when
 *  `sinceIso` is null (first run — full pull). */
export function txnModifiedFilter(sinceIso: string | null): string {
  if (!sinceIso) return '';
  return `\n      <ModifiedDateRangeFilter><FromModifiedDate>${escapeXml(toQbLocal(bumpSecond(sinceIso)))}</FromModifiedDate></ModifiedDateRangeFilter>`;
}

/** QB dates are YYYY-MM-DD already; pass through or null. */
export function qbDate(v: string | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

/** Number or null from a qbXML scalar. */
export function num(v: string | undefined): number | null {
  return v == null || v === '' ? null : Number(v);
}

/** Read a nested *Ref ({ListID, FullName}) block, e.g. CustomerRef, ItemRef. */
export function refField(scope: string, refName: string): { listId?: string; fullName?: string } {
  const b = blocks(scope, refName)[0];
  if (!b) return {};
  return { listId: tag(b, 'ListID'), fullName: tag(b, 'FullName') };
}

/** Join an address block's (BillAddressBlock/ShipAddressBlock) Addr1-5 lines with '\n', or null if absent. */
export function addrBlockText(scope: string, blockName: string): string | null {
  const b = blocks(scope, blockName)[0];
  if (!b) return null;
  const lines = ['Addr1', 'Addr2', 'Addr3', 'Addr4', 'Addr5'].map((n) => tag(b, n)).filter((v): v is string => !!v);
  return lines.length ? lines.join('\n') : null;
}

/** Read every DataExtRet (QB custom field) block in scope as {name, value, ownerId}. */
export function dataExtBlocks(scope: string): Array<{ name?: string; value?: string; ownerId?: string }> {
  return blocks(scope, 'DataExtRet').map((b) => ({
    name: tag(b, 'DataExtName'),
    value: tag(b, 'DataExtValue'),
    ownerId: tag(b, 'OwnerID'),
  }));
}

/** Extract transaction line rows (e.g. InvoiceLineRet) as a plain array. */
export function lineItems(scope: string, lineRetName: string): any[] {
  return blocks(scope, lineRetName).map((ln) => {
    const item = refField(ln, 'ItemRef');
    return {
      item: item.fullName ?? item.listId ?? null,
      desc: tag(ln, 'Desc') ?? null,
      quantity: num(tag(ln, 'Quantity')),
      rate: num(tag(ln, 'Rate')),
      amount: num(tag(ln, 'Amount')),
    };
  });
}
