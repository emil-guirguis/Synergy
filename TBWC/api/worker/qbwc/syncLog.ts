/**
 * QBWC sync run logging — writes public.qbwc_sync_run.
 *
 * Fully generic: instead of asking each object module to report counts, we scan
 * the raw receiveResponseXML payload for every qbXML *Rs block and log one row
 * per block. The Rs element name gives us the object and direction
 * (CustomerQueryRs -> Customer/pull, VendorAddRs -> Vendor/push) and the number
 * of <XxxRet> records inside gives rows_processed.
 *
 * Logging is best-effort: a failed insert must never break the sync loop, so
 * every write is wrapped in try/catch that only console.errors.
 */
import { Env, execQuery } from '../db';
import { RET_TYPES as ITEM_RET_TYPES } from './objects/item';

export interface SyncRunRow {
  ticket: string | null;
  objectType: string;
  direction: 'pull' | 'push' | 'error';
  statusCode: string | null;
  rowsProcessed: number;
  error: string | null;
  detail?: string | null;
}

/** Map an Rs element name to its object base name + direction. */
function classifyRs(rsName: string): { objectType: string; direction: 'pull' | 'push' } | undefined {
  // e.g. CustomerQueryRs, VendorAddRs, InvoiceModRs, ItemInventoryQueryRs
  const m = rsName.match(/^([A-Za-z]+?)(Query|Add|Mod|Del)Rs$/);
  if (!m) return undefined;
  return { objectType: m[1], direction: m[2] === 'Query' ? 'pull' : 'push' };
}

/**
 * Parse every *Rs block out of a receiveResponseXML payload.
 * Handles both paired (<XxxRs ...>...</XxxRs>) and self-closing (<XxxRs .../>)
 * forms — QB emits self-closing for empty result sets.
 */
export function parseRsBlocks(responseXml: string): SyncRunRow[] {
  const out: SyncRunRow[] = [];
  const rsOpen = /<([A-Za-z]+Rs)\b([^>]*?)(\/?)>/g;
  let m: RegExpExecArray | null;
  while ((m = rsOpen.exec(responseXml)) !== null) {
    const [, rsName, attrs, selfClose] = m;
    const cls = classifyRs(rsName);
    if (!cls) continue;
    // TxnDeletedQueryRs: salesOrderDeleted.ts logs one descriptive row per
    // deleted order itself (via logDeletion) — skip the vague aggregate here.
    if (cls.objectType === 'TxnDeleted') continue;

    const statusCode = attrs.match(/statusCode="([^"]*)"/)?.[1] ?? null;
    const statusMessage = attrs.match(/statusMessage="([^"]*)"/)?.[1] ?? null;

    let rows = 0;
    if (!selfClose) {
      const close = responseXml.indexOf(`</${rsName}>`, rsOpen.lastIndex);
      const body = close === -1
        ? responseXml.slice(rsOpen.lastIndex)
        : responseXml.slice(rsOpen.lastIndex, close);
      // Count only this object's Ret records (exact tag — <InvoiceRet> matches,
      // nested <InvoiceLineRet> does not). Item is the one object with no bare
      // <ItemRet> — QB always emits a type-specific variant instead.
      rows = cls.objectType === 'Item'
        ? ITEM_RET_TYPES.reduce((sum, t) => sum + (body.match(new RegExp(`<${t}>`, 'g')) || []).length, 0)
        : (body.match(new RegExp(`<${cls.objectType}Ret>`, 'g')) || []).length;
    }

    // statusCode 1 = "no matching records" — an empty pull, not an error.
    const isError = statusCode !== null && statusCode !== '0' && statusCode !== '1';
    out.push({
      ticket: null, // filled by caller
      objectType: cls.objectType,
      direction: cls.direction,
      statusCode,
      rowsProcessed: rows,
      error: isError ? (statusMessage || `statusCode ${statusCode}`) : null,
    });
  }
  return out;
}

async function insertRun(env: Env, r: SyncRunRow): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.qbwc_sync_run
       (ticket, object_type, direction, status_code, rows_processed, error, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [r.ticket, r.objectType, r.direction, r.statusCode, r.rowsProcessed, r.error, r.detail ?? null],
    'qbwc.syncLog.insert'
  );
}

/** Log every Rs block found in a response payload. Never throws. */
export async function logResponse(env: Env, ticket: string, responseXml: string): Promise<void> {
  try {
    for (const row of parseRsBlocks(responseXml)) {
      await insertRun(env, { ...row, ticket: ticket || null });
    }
  } catch (e) {
    console.error('[QBWC] sync log write failed:', e);
  }
}

/**
 * Log one descriptive row for a single deleted record (e.g. one SalesOrder QB
 * reported via TxnDeletedQueryRs) — used instead of the generic aggregate
 * scanner so the sync log reads "Deleted order TBWC 5687" per row rather than
 * one opaque "TxnDeleted: 3" row. No ticket: parseResponse() isn't handed the
 * QBWC session ticket, and the log table already allows a null one for
 * connection-level rows. Never throws.
 */
export async function logDeletion(env: Env, objectType: string, detail: string): Promise<void> {
  try {
    await insertRun(env, {
      ticket: null,
      objectType,
      direction: 'pull',
      statusCode: '0',
      rowsProcessed: 1,
      error: null,
      detail,
    });
  } catch (e) {
    console.error('[QBWC] sync log write failed:', e);
  }
}

/** Log a connection/request-level failure (hresult, connectionError). Never throws. */
export async function logError(
  env: Env,
  ticket: string | null,
  objectType: string,
  message: string
): Promise<void> {
  try {
    await insertRun(env, {
      ticket: ticket || null,
      objectType,
      direction: 'error',
      statusCode: null,
      rowsProcessed: 0,
      error: message,
    });
  } catch (e) {
    console.error('[QBWC] sync log write failed:', e);
  }
}
