/**
 * Settings > Backup's manual "download to disk" path — separate from (and
 * does not touch) storageBackup.ts's own Supabase-to-Supabase bucket mirror,
 * which keeps running on its own nightly schedule regardless.
 *
 * Two halves, both admin-triggered, both streamed rather than buffered:
 *
 *  - Database: the Worker has no pg_dump binary (no shell, no filesystem),
 *    so this builds its own logical dump — one NDJSON line per row, tables in
 *    FK-dependency order so a straight top-to-bottom replay never inserts a
 *    child before its parent. Streamed table-by-table, page-by-page (see
 *    PAGE_SIZE) so memory never holds more than one page at a time — the
 *    whole-DB JSON.stringify alternative risks the Worker's ~128MB isolate
 *    memory ceiling as this database grows past its current 193MB.
 *
 *  - Storage: paged listing + single-object byte streaming so the BROWSER can
 *    drive a save-every-file-to-a-chosen-folder loop (File System Access API)
 *    without ever asking the Worker to hold or zip 14+ GB at once — the same
 *    1000-subrequest-per-invocation ceiling that shaped storageBackup.ts's own
 *    batching applies here too, just paged from the client side instead.
 *
 * Restore is the reverse of each: a local script replays the NDJSON dump
 * (scripts/restore-db-dump.cjs) and the Settings panel re-uploads a chosen
 * folder's files back into the live buckets, object by object.
 */
import { Env, execQuery, withTransaction } from './db';

// One row page per query — small enough that even the widest table here
// (qb_item, qb_sales_order, etc.) stays well under a megabyte in memory.
const PAGE_SIZE = 2000;

type QueryFn = (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;

interface TableExport {
  table: string;
  pkCols: string[];
}

/** FK-dependency order for every public base table (Kahn's algorithm: an edge
 *  parent -> child means parent must be inserted first), plus each table's
 *  primary key column(s) for keyset paging. Looked up fresh every export
 *  rather than hardcoded, so a new migration's tables/FKs are picked up with
 *  no code change here. A table caught in an FK cycle (none known in this
 *  schema) falls back to name order at the end — the only cost is a possible
 *  transient FK violation restoring those specific rows, not a broken export. */
async function resolveExportOrder(q: QueryFn): Promise<TableExport[]> {
  const { rows: tableRows } = await q(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name`
  );
  const allTables: string[] = tableRows.map((r) => r.table_name);

  const { rows: fkRows } = await q(
    `SELECT confrelid::regclass::text AS parent, conrelid::regclass::text AS child
       FROM pg_constraint
      WHERE contype = 'f' AND connamespace = 'public'::regnamespace AND conrelid <> confrelid`
  );

  const { rows: pkRows } = await q(
    `SELECT tc.table_name, kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
      ORDER BY tc.table_name, kcu.ordinal_position`
  );
  const pkByTable = new Map<string, string[]>();
  for (const r of pkRows as { table_name: string; column_name: string }[]) {
    const list = pkByTable.get(r.table_name) ?? [];
    list.push(r.column_name);
    pkByTable.set(r.table_name, list);
  }

  const inDegree = new Map<string, number>(allTables.map((t) => [t, 0]));
  const children = new Map<string, string[]>(allTables.map((t) => [t, []]));
  for (const { parent, child } of fkRows as { parent: string; child: string }[]) {
    if (!inDegree.has(parent) || !inDegree.has(child)) continue; // FK onto a view or system table — not ours to order
    inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
    children.get(parent)!.push(child);
  }
  const queue = allTables.filter((t) => inDegree.get(t) === 0).sort();
  const order: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const t = queue.shift()!;
    if (seen.has(t)) continue;
    seen.add(t);
    order.push(t);
    for (const c of children.get(t) ?? []) {
      inDegree.set(c, (inDegree.get(c) ?? 0) - 1);
      if (inDegree.get(c) === 0) queue.push(c);
    }
  }
  for (const t of allTables) if (!seen.has(t)) order.push(t); // FK-cycle leftovers

  return order.map((table) => ({ table, pkCols: pkByTable.get(table) ?? [] }));
}

async function fetchPage(q: QueryFn, table: string, pkCols: string[], cursor: unknown[] | null, limit: number) {
  const cols = pkCols.map((c) => `"${c}"`);
  let sql = `SELECT * FROM public."${table}"`;
  const params: unknown[] = [];
  if (cursor) {
    sql += ` WHERE (${cols.join(', ')}) > (${cursor.map((_, i) => `$${i + 1}`).join(', ')})`;
    params.push(...cursor);
  }
  sql += ` ORDER BY ${cols.join(', ')} LIMIT $${params.length + 1}`;
  params.push(limit);
  return q(sql, params);
}

/** Streams the whole public schema as NDJSON: a manifest line, then per table
 *  a `{"table": "..."}` header line followed by one JSON line per row.
 *  Logs its own start/finish to cron_run_log under job_name 'exportDatabase'
 *  — done here (inside the stream's own async body) rather than wrapped by
 *  cronMonitor's runJob(), since runJob times a function that returns before
 *  work is done; here "done" only happens once the stream itself closes. */
export function streamDatabaseDump(env: Env): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let logId: number | null = null;
      try {
        const r = await execQuery(
          env,
          `INSERT INTO public.cron_run_log (job_name, status) VALUES ('exportDatabase', 'running') RETURNING cron_run_log_id`,
          [],
          'backupExport.db.logStart'
        );
        logId = r.rows[0]?.cron_run_log_id ?? null;
      } catch (e) {
        console.error('[backupExport] cron_run_log start failed:', e instanceof Error ? e.message : e);
      }

      let tablesWritten = 0;
      let rowsWritten = 0;
      try {
        await withTransaction(env, async (q) => {
          const tables = await resolveExportOrder(q);
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ exportedAt: new Date().toISOString(), tableOrder: tables.map((t) => t.table) }) + '\n'
            )
          );
          for (const { table, pkCols } of tables) {
            controller.enqueue(encoder.encode(JSON.stringify({ table }) + '\n'));
            if (pkCols.length === 0) {
              // No primary key (shouldn't happen under this project's naming
              // convention, but information_schema is the source of truth,
              // not the convention) — one unpaginated fetch instead of an
              // unbounded keyset loop with nothing to advance the cursor.
              const { rows } = await q(`SELECT * FROM public."${table}"`);
              for (const row of rows) controller.enqueue(encoder.encode(JSON.stringify(row) + '\n'));
              rowsWritten += rows.length;
            } else {
              let cursor: unknown[] | null = null;
              while (true) {
                const { rows } = await fetchPage(q, table, pkCols, cursor, PAGE_SIZE);
                for (const row of rows) controller.enqueue(encoder.encode(JSON.stringify(row) + '\n'));
                rowsWritten += rows.length;
                if (rows.length < PAGE_SIZE) break;
                cursor = pkCols.map((c) => rows[rows.length - 1][c]);
              }
            }
            tablesWritten++;
          }
        });
        controller.close();
        if (logId != null) {
          await execQuery(
            env,
            `UPDATE public.cron_run_log SET status = 'ok', finished_at = now(), duration_ms = $2, detail = $3 WHERE cron_run_log_id = $1`,
            [logId, Date.now() - startedAt, { tables: tablesWritten, rows: rowsWritten }],
            'backupExport.db.logFinish'
          ).catch((e) => console.error('[backupExport] cron_run_log finish failed:', e instanceof Error ? e.message : e));
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        console.error('[backupExport] database dump failed:', message);
        controller.error(e);
        if (logId != null) {
          await execQuery(
            env,
            `UPDATE public.cron_run_log SET status = 'error', finished_at = now(), duration_ms = $2, error = $3 WHERE cron_run_log_id = $1`,
            [logId, Date.now() - startedAt, message],
            'backupExport.db.logError'
          ).catch((e2) => console.error('[backupExport] cron_run_log error-log failed:', e2 instanceof Error ? e2.message : e2));
        }
      }
    },
  });
}

// --- Storage: paged listing + single-object transfer, against the LIVE
// buckets directly (not the 'storage-backup' mirror) — this is a backup of
// current storage, independent of that mirror job. ------------------------

export interface LiveStorageObject {
  name: string;
  size: number | null;
}

export interface LiveStorageListResult {
  objects: LiveStorageObject[];
  cursor: string | null;
}

export async function listLiveStorageObjects(
  env: Env,
  bucket: string,
  cursor: string | null,
  limit: number
): Promise<LiveStorageListResult> {
  const { rows } = await execQuery(
    env,
    `SELECT name, (metadata->>'size')::bigint AS size
       FROM storage.objects
      WHERE bucket_id = $1 AND is_delete_marker = false AND archived_at IS NULL AND name > $2
      ORDER BY name
      LIMIT $3`,
    [bucket, cursor ?? '', limit],
    'backupExport.storage.list'
  );
  return { objects: rows, cursor: rows.length === limit ? rows[rows.length - 1].name : null };
}

/** Uploads bytes into the LIVE bucket (not the mirror) — overwrites whatever
 *  is there now. The reverse of listLiveStorageObjects + the frontend's
 *  object-read call: restoring a folder the admin exported earlier. */
export async function restoreObjectToLiveBucket(env: Env, bucket: string, path: string, bytes: ArrayBuffer): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('Supabase service role key not configured');
  const res = await fetch(`${env.SUPABASE_URL}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/octet-stream',
      'x-upsert': 'true',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Supabase upload failed: ${res.status} ${await res.text().catch(() => '')}`);
}

// --- Supabase's own managed Postgres backups (Management API) — read-only
// visibility, no copying: Supabase already keeps these, this just surfaces
// them next to our own exports so Backup is one page for both. -------------

function projectRefFromUrl(url: string): string | null {
  const m = url.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/);
  return m ? m[1] : null;
}

export interface ManagedBackupsResult {
  /** False when SUPABASE_ACCESS_TOKEN isn't set — the panel shows a setup hint instead of an error. */
  configured: boolean;
  pitrEnabled?: boolean;
  backups?: unknown[];
  error?: string;
}

export async function listManagedBackups(env: Env): Promise<ManagedBackupsResult> {
  if (!env.SUPABASE_ACCESS_TOKEN) return { configured: false };
  const ref = projectRefFromUrl(env.SUPABASE_URL);
  if (!ref) return { configured: true, error: 'Could not determine project ref from SUPABASE_URL' };
  try {
    const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/backups`, {
      headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
    });
    if (!res.ok) return { configured: true, error: `Supabase Management API: ${res.status} ${await res.text().catch(() => '')}` };
    const body = (await res.json()) as { backups?: unknown[]; pitr_enabled?: boolean };
    return { configured: true, backups: body.backups ?? [], pitrEnabled: body.pitr_enabled ?? false };
  } catch (e) {
    return { configured: true, error: e instanceof Error ? e.message : 'Request failed' };
  }
}
