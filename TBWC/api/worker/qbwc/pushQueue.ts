/**
 * Generic outbox for edits made in TBWC that need to be pushed back to
 * QuickBooks Desktop. One row per (object_type, txn_id, field_name) — a new
 * edit overwrites the still-pending one rather than piling up history.
 *
 * `field_name` is the TBWC/schema-facing name (e.g. "memo"), not the
 * QB XML tag — each QBWC object module (salesOrder.ts, etc.) owns its own
 * field_name -> QB tag map and is responsible for building the actual *ModRq.
 * This module only tracks "what's queued" and "did it push" so adding a new
 * pushable field never needs a migration — just a map entry in the route and
 * in the object module's push builder.
 */
import { Env, execQuery } from '../db';

export interface PendingPush {
  txn_id: string;
  field_name: string;
  new_value: string | null;
}

/** Queue (or replace) an edit awaiting push. Call from the route handler that accepts the edit. */
export async function queueFieldPush(
  env: Env,
  objectType: string,
  txnId: string,
  fieldName: string,
  newValue: string | null
): Promise<void> {
  await execQuery(
    env,
    `INSERT INTO public.qbwc_push_queue (object_type, txn_id, field_name, new_value, status, updated_at)
     VALUES ($1,$2,$3,$4,'pending', CURRENT_TIMESTAMP)
     ON CONFLICT (object_type, txn_id, field_name) DO UPDATE SET
       new_value = EXCLUDED.new_value, status = 'pending', error = NULL, updated_at = CURRENT_TIMESTAMP`,
    [objectType, txnId, fieldName, newValue],
    'qbwc.pushQueue.enqueue'
  );
}

/** Everything still owed to QB for one object type (pending + previously-failed, retried every session). */
export async function pendingPushes(env: Env, objectType: string): Promise<PendingPush[]> {
  const r = await execQuery(
    env,
    `SELECT txn_id, field_name, new_value
       FROM public.qbwc_push_queue
      WHERE object_type = $1 AND status IN ('pending', 'failed')`,
    [objectType],
    'qbwc.pushQueue.list'
  );
  return r.rows;
}

/** Effective (still-pending) value for one field, or null if nothing queued — for surfacing in GET responses. */
export async function pendingValue(env: Env, objectType: string, txnId: string, fieldName: string): Promise<string | null> {
  const r = await execQuery(
    env,
    `SELECT new_value FROM public.qbwc_push_queue
      WHERE object_type = $1 AND txn_id = $2 AND field_name = $3 AND status IN ('pending', 'failed')`,
    [objectType, txnId, fieldName],
    'qbwc.pushQueue.value'
  );
  return r.rows[0]?.new_value ?? null;
}

/** A push succeeded for these fields on this record — drop them from the queue. */
export async function markPushed(env: Env, objectType: string, txnId: string, fieldNames: string[]): Promise<void> {
  if (fieldNames.length === 0) return;
  await execQuery(
    env,
    `DELETE FROM public.qbwc_push_queue
      WHERE object_type = $1 AND txn_id = $2 AND field_name = ANY($3::text[])`,
    [objectType, txnId, fieldNames],
    'qbwc.pushQueue.clear'
  );
}

/** A push failed — keep the row (retried next session) but record why. */
export async function markFailed(env: Env, objectType: string, txnId: string, fieldNames: string[], error: string): Promise<void> {
  if (fieldNames.length === 0) return;
  await execQuery(
    env,
    `UPDATE public.qbwc_push_queue SET status = 'failed', error = $4, updated_at = CURRENT_TIMESTAMP
      WHERE object_type = $1 AND txn_id = $2 AND field_name = ANY($3::text[])`,
    [objectType, txnId, fieldNames, error],
    'qbwc.pushQueue.fail'
  );
}
