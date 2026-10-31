/**
 * Inventory (product catalog). Table public.qb_item, PK qb_item_id — the
 * QB-synced item list. Reads: any approved user.
 *
 * WRITES ARE AN ALLOWLIST, NOT A CRUD MODULE. Items exist only via the
 * QuickBooks sync, so POST/DELETE still 405 and PUT writes exactly the columns
 * in PUT_ALLOWLIST — everything else in the body is dropped on the floor. That
 * keeps the read-only freeze on every QB-owned field (name, price, desc…) and
 * on the TBWC-owned columns from migration 012 that are still being verified,
 * while letting the kit fields from migration 028 be edited. Adding a column
 * here is a deliberate act: put it in PUT_ALLOWLIST and drop its readOnly in
 * inventorySchema.ts, in that order.
 *
 * Two writes sit outside the record PUT because they are their own workflows:
 *   PATCH /:id/image      — thumbnail review verdict (migration 027).
 *   PUT   /:id/kit-items  — the contents of a kit (migration 028), replaced as
 *                           a set; the grid owns the whole list, not rows.
 */
import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { Env, execQuery, withTransaction } from '../db';
import { AuthVariables, authenticateToken, isCatalogCurator, requirePermission } from '../middleware';
import { findAll, findById, update, whereFromQuery, likeFieldsFromSchema, NOT_NULL } from '../crud';
import { inventorySchema } from './inventorySchema';
import { runAiChatLoop, type AiChatTool } from '@meterit/framework-backend/api/base/aiChat';
import { toClaudeTools, toClaudeMessages, fromClaudeMessage } from '../claudeChatAdapter';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);

const TABLE = 'qb_item';
const PK = 'qb_item_id';
const SEARCH = ['name', 'full_name', 'sales_desc', 'category', 'upc_code'];
// Free-text individual filters, derived from the schema (list-shown string/number
// fields with no enumValues).
const LIKE_FIELDS = likeFieldsFromSchema(inventorySchema);

app.get('/', requirePermission('inventory:read'), async (c) => {
  const q = c.req.query();
  // hasImage is a synthetic filter — "does this row have a thumbnail at all",
  // which is the question when working through the catalog, and no single
  // image_status value answers it (auto and approved both have a picture;
  // pending, rejected and none don't). Keep it out of whereFromQuery's generic
  // pass and turn it into the NULL check below.
  const { where: fieldWhere, whereLike } = whereFromQuery(q, { likeFields: LIKE_FIELDS, extraReserved: ['hasImage', 'searchFields'] });
  // Deleted in QB (see qbwc/objects/listDeleted.ts) — the row survives because
  // kit_items/quote_line point at it, but it is out of the live catalog.
  const where: Record<string, any> = { ...fieldWhere, qb_deleted_at: null };
  if (q.hasImage === 'true') where.image_url = NOT_NULL;
  if (q.hasImage === 'false') where.image_url = null;
  // A caller (e.g. an item picker) can narrow the default multi-field search to a subset of
  // SEARCH — e.g. just the item code, not its description/category too. Intersected against
  // SEARCH rather than trusted outright, so a request can't probe an arbitrary column.
  const requestedSearchFields = q.searchFields ? q.searchFields.split(',').map((f) => f.trim()) : null;
  const searchFields = requestedSearchFields
    ? SEARCH.filter((f) => requestedSearchFields.includes(f))
    : SEARCH;
  const result = await findAll(c.env, {
    table: TABLE,
    primaryKey: PK,
    page: q.page ? parseInt(q.page, 10) : 1,
    limit: q.limit ? parseInt(q.limit, 10) : 25,
    search: q.search,
    searchFields: searchFields.length > 0 ? searchFields : SEARCH,
    sortBy: q.sortBy,
    sortOrder: q.sortOrder,
    orderBy: q.sortBy ? undefined : `"${TABLE}".name ASC`,
    where,
    whereLike,
  });
  return c.json({ success: true, data: { items: result.rows, total: result.pagination.total } });
});

// Fallback for the quote line grid's voice-add mic (ChildRowsGrid's voiceAdd.aiFallback):
// called only when the client's own naive "<qty> <item>" split and plain ILIKE search (GET /,
// above) came back empty. `text` here is the RAW transcript, not a pre-split item term — the
// split itself is ambiguous whenever the item's own name starts with a number (amperage/gauge/
// voltage: "1 Amp Fuse", "20 Amp Breaker"), which collides with a spoken quantity, made worse by
// speech-to-text sometimes running two spoken numbers together ("ten one amp fuses" -> "101 amp
// fuses"). So this re-derives both qty and the item from the whole transcript, trying alternate
// digit splits via search_catalog rather than trusting the client's first guess at either one.
// Same search_catalog tool/SQL as the AI chat quote wizard (routes/aiChat.ts), kept separate here
// since this is a narrow one-shot resolver, not a conversation.
const VOICE_MATCH_TOOL: AiChatTool = {
  type: 'function',
  function: {
    name: 'search_catalog',
    description: 'Search the product catalog by part number, name, or description (substring, case-insensitive).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to match against part number/name/description' },
        limit: { type: 'number', description: 'Maximum number of items to return (default 20)' },
      },
      required: ['text'],
    },
  },
};

const VOICE_MATCH_SYSTEM_PROMPT =
  'Parse a spoken "add a line item" request (quantity + item) and resolve the item via the search_catalog tool. ' +
  'Normally it\'s "<quantity> <item description>" (e.g. "add 10 1 amp fuses" = qty 10, item "1 amp fuse"), but ' +
  'this is genuinely ambiguous: many catalog items themselves start with a number (amperage/gauge/voltage — ' +
  '"1 Amp Fuse", "12 Gauge Wire", "20 Amp Breaker"), and speech-to-text sometimes runs two spoken numbers ' +
  'together with no space (e.g. "ten one amp fuses" transcribed as "101 amp fuses" instead of "10 1 amp ' +
  'fuses"). Try the obvious split first; if search_catalog finds nothing, try other splits of the leading digits ' +
  'between quantity and item before giving up (e.g. for "101 amp fuses", also try quantity 10 / item "1 amp ' +
  'fuses"). Also retry with a simpler or singular item term (drop a trailing "s", drop extra words) if the exact ' +
  'wording finds nothing. Once satisfied, or sure nothing matches, respond with ONLY this JSON and nothing else ' +
  '(no markdown, no commentary): {"qty": number, "matches": [qb_item_id, ...]} — matches up to 5 ids, best match ' +
  'first, empty array if nothing matches; qty defaults to 1 if it truly can\'t be determined.';

app.post('/voice-match', requirePermission('inventory:read'), async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ success: false, message: 'AI match is not configured (ANTHROPIC_API_KEY missing)' }, 503);
  }
  let body: { text?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid JSON body' }, 400);
  }
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) return c.json({ success: false, message: 'text is required' }, 400);

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const tools = [VOICE_MATCH_TOOL];

  try {
    const { response } = await runAiChatLoop(text, [], {
      systemPrompt: VOICE_MATCH_SYSTEM_PROMPT,
      tools,
      maxIterations: 4,
      complete: async (messages) => {
        const { system, messages: claudeMessages } = toClaudeMessages(messages);
        const res = await client.messages.create({
          model: 'claude-sonnet-5',
          max_tokens: 512,
          system,
          tools: toClaudeTools(tools),
          messages: claudeMessages,
        });
        return fromClaudeMessage(res);
      },
      executeTool: async (toolName, toolInput) => {
        if (toolName !== 'search_catalog') return JSON.stringify({ error: `Unknown tool: ${toolName}` });
        const searchText = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!searchText) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 50);
        const result = await execQuery(
          c.env,
          `SELECT qb_item_id, name, full_name, sales_desc, sales_price
             FROM public.qb_item
            WHERE qb_deleted_at IS NULL AND is_active = true
              AND (name ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%' OR sales_desc ILIKE '%' || $1 || '%')
            ORDER BY name ASC LIMIT $2`,
          [searchText, limit],
          'inventory.voiceMatch.search_catalog'
        );
        return JSON.stringify(result.rows);
      },
    });


    let qty = 1;
    let matchIds: number[] = [];
    try {
      const parsed = JSON.parse(response.trim());
      const parsedQty = Number(parsed?.qty);
      if (Number.isFinite(parsedQty) && parsedQty > 0) qty = parsedQty;
      // The model's free-text JSON answer isn't schema-enforced — it sometimes emits ids as
      // strings ({"matches": ["69"]}) rather than numbers, so coerce rather than filter by typeof.
      if (Array.isArray(parsed?.matches)) {
        matchIds = parsed.matches.map((x: unknown) => Number(x)).filter((n: number) => Number.isFinite(n));
      }
    } catch {
      // Treated as no match below — e.g. the model answered in prose instead of JSON.
    }
    if (matchIds.length === 0) return c.json({ success: true, data: { qty, items: [] } });

    const result = await execQuery(
      c.env,
      `SELECT qb_item_id, name, full_name, sales_desc, sales_price
         FROM public.qb_item
        WHERE qb_item_id = ANY($1) AND qb_deleted_at IS NULL`,
      [matchIds],
      'inventory.voiceMatch.resolve'
    );
    // Preserve the model's ranked order — ANY($1) doesn't guarantee one. qb_item_id is bigint,
    // so pg returns it as a string (r.qb_item_id === "69") — keyed by Number() here so the lookup
    // below (matchIds are numbers) actually hits instead of silently missing every row.
    const byId = new Map(result.rows.map((r: any) => [Number(r.qb_item_id), r]));
    const items = matchIds.map((id) => byId.get(id)).filter(Boolean);
    return c.json({ success: true, data: { qty, items } });
  } catch (e) {
    console.error('[inventory.voice-match] failed:', e);
    return c.json({ success: false, message: 'AI match failed' }, 500);
  }
});

app.get('/:id', requirePermission('inventory:read'), async (c) => {
  const row = await findById(c.env, TABLE, PK, c.req.param('id'));
  if (!row || row.qb_deleted_at) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: row });
});

/**
 * Image review verdict. Admin only.
 *
 * 'approved' / 'rejected' are terminal as far as the fetch script is concerned —
 * it filters both out of its work set — so this is what stops a re-run from
 * undoing a human's decision. Rejecting also clears image_url, because a
 * rejected picture is a wrong picture and leaving it in the column risks it
 * reaching the printout through some other query.
 */
const IMAGE_VERDICTS = ['approved', 'rejected', 'auto', 'pending', 'none'] as const;

/**
 * Curating the catalog (Type/Notes edits, image review) is narrower than
 * inventory:write: it is restricted to permissions.ts's CATALOG_CURATOR_EMAILS
 * — see that list for why it is a code-owned list of people rather than a
 * grant. 403 rather than 404: the caller may read the item perfectly well,
 * they just may not curate it.
 */
const requireCatalogCurator = (c: any) =>
  isCatalogCurator(c.get('user')?.email)
    ? null
    : c.json({ success: false, message: 'Catalog curation is limited to the catalog owner' }, 403);

app.patch('/:id/image', requirePermission('inventory:write'), async (c) => {
  const denied = requireCatalogCurator(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({} as any));
  const status = body?.image_status;
  if (!IMAGE_VERDICTS.includes(status)) {
    return c.json({ success: false, message: `image_status must be one of ${IMAGE_VERDICTS.join(', ')}` }, 400);
  }

  // A hand-supplied URL is allowed (paste the right picture when the machine
  // got it wrong), but only an https one — this value ends up in an <img src>
  // on a rep-facing page and in the print pipeline.
  const manualUrl = typeof body.image_url === 'string' ? body.image_url.trim() : undefined;
  if (manualUrl !== undefined && manualUrl !== '' && !/^https:\/\//i.test(manualUrl)) {
    return c.json({ success: false, message: 'image_url must be an https URL' }, 400);
  }

  const clearUrl = status === 'rejected' || manualUrl === '';
  const result = await execQuery(
    c.env,
    `UPDATE qb_item
        SET image_status = $2,
            image_url = CASE WHEN $3::boolean THEN NULL
                             WHEN $4::text IS NOT NULL THEN $4::text
                             ELSE image_url END,
            image_source = CASE WHEN $4::text IS NOT NULL THEN 'manual' ELSE image_source END,
            image_confidence = CASE WHEN $4::text IS NOT NULL THEN 100 ELSE image_confidence END,
            image_updated_at = now()
      WHERE qb_item_id = $1::bigint
      RETURNING qb_item_id, image_url, image_status, image_source, image_confidence, image_source_url`,
    [c.req.param('id'), status, clearUrl, manualUrl || null],
    'inventory image verdict'
  );

  if (!result.rows.length) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: result.rows[0] });
});

/**
 * A kit's lines with the child item joined in, so the grid can render one
 * without a round trip per row. `item_on_hand` is QuickBooks' stock level
 * (migration 029) and is NULL for item types QB does not stock-track — the UI
 * must show that as blank, not 0.
 * A child deleted in QB (item_deleted_at set) is still returned rather than
 * filtered out: silently dropping it would make the kit look complete and let
 * the next replace-all save erase the line without anyone deciding to.
 */
const KIT_ITEMS_SELECT = `SELECT k.kit_items_id, k.qb_item_id, k.item_id, k.group_id, k.group_desc, k.order_by, k.qty, k.required,
            i.name AS item_name, i.sales_desc AS item_desc, i.sales_price AS item_price,
            i.image_url AS item_image_url, i.quantity_on_hand AS item_on_hand,
            i.qb_deleted_at AS item_deleted_at
       FROM kit_items k
       JOIN qb_item i ON i.qb_item_id = k.item_id
      WHERE k.qb_item_id = $1::bigint
      ORDER BY k.group_id NULLS FIRST, k.order_by, k.kit_items_id`;

/**
 * What a replace-all kit save actually does, relative to what's stored — so
 * the PUT can require inventoryGridKitItem:create/delete/write for exactly the
 * kinds of change it carries, even though the grid sends the whole list.
 * Rows are matched by item_id (the n-th occurrence of an item to the n-th);
 * `changed` = a matched row's qty/required/group differs, or the matched rows'
 * relative order differs (adding or removing rows alone never counts as an
 * edit, even though it renumbers order_by below it).
 */
export function diffKitItems(
  existing: { item_id: any; group_id: any; group_desc: any; qty: any; required: any }[],
  incoming: { item_id: number; group_id: number | null; group_desc: string | null; qty: number; required: boolean }[]
): { added: boolean; removed: boolean; changed: boolean } {
  const pool = new Map<number, { row: (typeof existing)[number]; seq: number }[]>();
  existing.forEach((row, seq) => {
    const id = Number(row.item_id);
    if (!pool.has(id)) pool.set(id, []);
    pool.get(id)!.push({ row, seq });
  });
  let added = false;
  let changed = false;
  const matchedSeq: number[] = [];
  for (const l of incoming) {
    const match = pool.get(l.item_id)?.shift();
    if (!match) { added = true; continue; }
    matchedSeq.push(match.seq);
    const r = match.row;
    if (
      Number(r.qty) !== l.qty ||
      (r.required !== false) !== l.required ||
      (r.group_id == null ? null : Number(r.group_id)) !== l.group_id ||
      (r.group_desc ?? null) !== l.group_desc
    ) changed = true;
  }
  const removed = [...pool.values()].some((left) => left.length > 0);
  if (matchedSeq.some((s, i) => i > 0 && s < matchedSeq[i - 1])) changed = true;
  return { added, removed, changed };
}

/**
 * Kit contents. `qb_item_id` is the KIT, `item_id` the child line — both FK to
 * qb_item (migration 028). Gated by the grid's own inventoryGridKitItem:read
 * (migration 098 granted it to every inventory:read holder — reps need to see
 * what is in a kit before quoting it).
 */
app.get('/:id/kit-items', requirePermission('inventoryGridKitItem:read'), async (c) => {
  const rows = await execQuery(
    c.env,
    KIT_ITEMS_SELECT,
    [c.req.param('id')],
    'inventory kit items'
  );
  return c.json({ success: true, data: { items: rows.rows } });
});

/**
 * Replace a kit's contents wholesale. Needs inventoryGridKitItem:create /
 * :delete / :write for whichever of add / remove / edit the new list implies
 * (diffKitItems above) — a role can e.g. reorder and re-quantity a kit
 * without being able to drop lines from it.
 *
 * Replace-all rather than per-row CRUD because the grid's unit of work is the
 * whole ordering: one drag rewrites `order_by` on every row below it and can
 * move a row between groups, so sending the list as it now stands is both
 * simpler and atomic. Same shape as the quote/quote_line save (quotes.ts).
 * `order_by` is assigned server-side from array position within each group —
 * the client's job is the order, not the numbering.
 */
app.put('/:id/kit-items', requirePermission('inventoryGridKitItem:read'), async (c) => {
  const kitId = c.req.param('id');
  const kit = await execQuery(
    c.env,
    `SELECT qb_item_id, type FROM qb_item WHERE qb_item_id = $1::bigint AND qb_deleted_at IS NULL`,
    [kitId]
  );
  if (!kit.rows.length) return c.json({ success: false, message: 'Inventory item not found' }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const raw = Array.isArray(body?.items) ? body.items : null;
  if (!raw) return c.json({ success: false, message: 'items must be an array' }, 400);

  const kitIdNum = Number(kitId);
  const lines: {
    item_id: number; group_id: number | null; group_desc: string | null;
    qty: number; required: boolean;
  }[] = [];
  for (const l of raw) {
    const itemId = Number(l?.item_id);
    if (!Number.isInteger(itemId) || itemId <= 0) {
      return c.json({ success: false, message: 'every line needs a numeric item_id' }, 400);
    }
    // Omitted qty means one of the item — the column's own default. Mirrors
    // kit_items_qty_check so a bad value is a 400, not a constraint violation.
    const qty = l?.qty === undefined || l?.qty === null || l?.qty === '' ? 1 : Number(l.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return c.json({ success: false, message: 'qty must be a number greater than zero' }, 400);
    }
    // Mirrors the kit_items_no_self_check constraint, so a bad payload comes
    // back as a 400 and not a 500 out of the driver.
    if (itemId === kitIdNum) {
      return c.json({ success: false, message: 'A kit cannot contain itself.' }, 400);
    }
    const group = l?.group_id === null || l?.group_id === undefined || l.group_id === '' ? null : Number(l.group_id);
    if (group !== null && !Number.isInteger(group)) {
      return c.json({ success: false, message: 'group_id must be a whole number or empty' }, 400);
    }
    const desc = typeof l?.group_desc === 'string' && l.group_desc.trim() !== '' ? l.group_desc.trim() : null;
    // Required unless the client explicitly says otherwise — the column's own
    // default, and what a kit line means when nobody has thought about it.
    lines.push({ item_id: itemId, group_id: group, group_desc: desc, qty, required: l?.required !== false });
  }

  // Every child must be a real catalog row. Checked up front so a typo'd id
  // fails as a 400 instead of surfacing as an FK violation mid-transaction.
  if (lines.length) {
    const ids = [...new Set(lines.map((l) => l.item_id))];
    const found = await execQuery(
      c.env,
      // qb_deleted_at IS NULL: a child deleted in QB can't be added to a kit —
      // it reports back through the same "Unknown inventory item(s)" 400.
      `SELECT qb_item_id FROM qb_item WHERE qb_item_id = ANY($1::bigint[]) AND qb_deleted_at IS NULL`,
      [ids],
      'inventory kit items validate'
    );
    if (found.rows.length !== ids.length) {
      const have = new Set(found.rows.map((r: any) => Number(r.qb_item_id)));
      const missing = ids.filter((id) => !have.has(id));
      return c.json({ success: false, message: `Unknown inventory item(s): ${missing.join(', ')}` }, 400);
    }
  }

  // group_desc is denormalised onto every line (migration 031), so one group
  // must not end up with two labels. First non-empty one in the list wins and
  // is stamped on the whole group — including lines the client sent blank,
  // which is what dragging a row into a named group produces.
  const groupNames = new Map<string, string | null>();
  for (const l of lines) {
    const key = String(l.group_id);
    if (!groupNames.get(key) && l.group_desc) groupNames.set(key, l.group_desc);
  }
  for (const l of lines) l.group_desc = groupNames.get(String(l.group_id)) ?? null;

  const current = await execQuery(c.env, KIT_ITEMS_SELECT, [kitId], 'inventory kit items before save');
  const diff = diffKitItems(current.rows, lines);
  const perms = c.get('permissions');
  const missing = [
    diff.added && !perms.has('inventoryGridKitItem:create') && 'add',
    diff.removed && !perms.has('inventoryGridKitItem:delete') && 'remove',
    diff.changed && !perms.has('inventoryGridKitItem:write') && 'edit',
  ].filter(Boolean);
  if (missing.length) {
    return c.json({ success: false, message: `Insufficient permissions to ${missing.join('/')} kit items` }, 403);
  }

  await withTransaction(c.env, async (q) => {
    await q(`DELETE FROM kit_items WHERE qb_item_id = $1::bigint`, [kitId]);
    // order_by counts within a group, so each group reads 0,1,2… on its own —
    // the grid groups before it sorts, and a global counter would leave
    // confusing gaps in every group after the first.
    const seq = new Map<string, number>();
    for (const l of lines) {
      const key = String(l.group_id);
      const n = seq.get(key) ?? 0;
      seq.set(key, n + 1);
      await q(
        `INSERT INTO kit_items (qb_item_id, item_id, group_id, group_desc, order_by, qty, required)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [kitId, l.item_id, l.group_id, l.group_desc, n, l.qty, l.required]
      );
    }
  });

  // Return the saved list in its stored shape so the panel can adopt the
  // server's row ids and ordering instead of guessing at them.
  const rows = await execQuery(
    c.env,
    KIT_ITEMS_SELECT,
    [kitId],
    'inventory kit items saved'
  );
  return c.json({ success: true, data: { items: rows.rows } });
});

/**
 * Record update, restricted to the TBWC-owned kit fields. Admin only.
 *
 * Not a general CRUD update: anything outside PUT_ALLOWLIST is ignored
 * silently rather than rejected, because the form posts the whole record back
 * (every QB-owned field included) and a 400 on fields the user never touched
 * would make the form unsaveable. The schema marks those fields readOnly so
 * they are never editable in the UI either — this is the backstop.
 */
const PUT_ALLOWLIST = ['type', 'notes'] as const;
const ITEM_TYPES = ['kit', 'item'];

app.put('/:id', requirePermission('inventory:write'), async (c) => {
  const denied = requireCatalogCurator(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({} as any));
  const data: Record<string, any> = {};
  for (const col of PUT_ALLOWLIST) {
    if (body[col] !== undefined) data[col] = body[col];
  }

  if (data.type !== undefined && !ITEM_TYPES.includes(data.type)) {
    return c.json({ success: false, message: `type must be one of ${ITEM_TYPES.join(', ')}` }, 400);
  }
  // '' from an empty textarea means "no notes", not an empty string to store.
  if (typeof data.notes === 'string' && data.notes.trim() === '') data.notes = null;

  if (!Object.keys(data).length) {
    return c.json({ success: false, message: `Nothing editable in the payload (editable: ${PUT_ALLOWLIST.join(', ')}).` }, 400);
  }

  // qb_item has no updated_at column (it is a QB staging table — synced_at is
  // the sync's own clock), so the helper must not append one.
  const row = await update(c.env, TABLE, PK, c.req.param('id'), data, { touchUpdatedAt: false });
  if (!row) return c.json({ success: false, message: 'Inventory item not found' }, 404);
  return c.json({ success: true, data: row });
});

app.post('/', requirePermission('inventory:write'), (c) =>
  c.json({ success: false, message: 'Inventory items are created by the QuickBooks sync and cannot be created here.' }, 405));
app.delete('/:id', requirePermission('inventory:write'), (c) =>
  c.json({ success: false, message: 'Inventory items are managed by the QuickBooks sync and cannot be deleted here.' }, 405));

export default app;
