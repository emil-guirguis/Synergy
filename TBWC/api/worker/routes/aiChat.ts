/**
 * AI Chat route — Cloudflare Worker.
 *
 * POST /api/ai/chat
 * Body: { message: string, history?: { role: 'user' | 'assistant', content: string }[] }
 *
 * Uses Claude (claude-sonnet-5) with tool use, same shared agentic loop as
 * MeterItPro's aiChat.ts (see @meterit/framework-backend/api/base/aiChat).
 * Tool set is TBWC-specific — order/invoice header search (customer, job
 * name, PO, notes, ref number) plus line-item search on both, which lets a
 * rep find a serial/part number without knowing which order or invoice it's
 * on (qb_sales_order.lines / qb_invoice.lines are jsonb arrays; a serial
 * number lives free-text inside a line's `desc`, not its own column, so line
 * search is jsonb_array_elements + ILIKE, not an exact-match query) — plus
 * inventory/product-catalog search (public.qb_item, pricing questions) and a
 * generic run_sql_query tool (read-only SELECT, keyword+semicolon blocklist,
 * auto-wrapped with LIMIT 500) for ad-hoc analysis/aggregates across any
 * public table that the fixed search tools can't answer.
 *
 * Admin-only. None of the tools below scope their queries to the caller's own
 * sales rep, so a rep asking a question would read every rep's orders plus the
 * whole invoice/customer set — the rest of the rep portal is scoped to their
 * own rep_id. The Ask AI nav item and /ai-chat route are admin-gated to match.
 */
import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { Env, execQuery } from '../db';
import { authenticateToken, requirePermission, AuthVariables } from '../middleware';
import {
  runAiChatLoop,
  AiChatTool,
  describeAiChatError,
  AI_CHAT_SCOPE_GUARDRAIL,
} from '@meterit/framework-backend/api/base/aiChat';
import { toClaudeTools, toClaudeMessages, fromClaudeMessage } from '../claudeChatAdapter';
import {
  executeMemoryCommand,
  AI_MEMORY_TOOL_NAME,
  AI_MEMORY_CLAUDE_TOOL,
  AI_MEMORY_GUIDELINE,
} from '@meterit/framework-backend/api/base/aiMemory';
import { searchDocumentsMetadata, searchDocumentsContent } from '@meterit/framework-backend/api/base/aiSearch';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('aichat:use'));

// --- Tool definitions ---------------------------------------------------------

const TOOLS: AiChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_orders',
      description:
        "Search sales orders by customer name, job name, PO number, order ref number, sales rep, ship/bill " +
        "address, or notes/build notes text — use this to find an order when you don't know its exact order " +
        'number, e.g. by job site, customer address, or a note. Does NOT search line item text — a serial ' +
        "number, part number, or shipping tracking number lives inside a line's description, not these header " +
        'fields, so use search_order_lines for those instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name, job name, PO number, ref number, sales rep, ship/bill address, or notes' },
          limit: { type: 'number', description: 'Maximum number of orders to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_order_lines',
      description:
        "Search sales order line items for text — use this to find a serial number, part number, shipping " +
        "tracking number, or any other text that appears in a line item's description, even if you don't know " +
        "which order it's on. Matches anywhere in the line description (substring, case-insensitive). Any long " +
        'alphanumeric code the user gives you (tracking numbers included) is almost always found here, not in ' +
        'search_orders.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to search for within order line descriptions' },
          limit: { type: 'number', description: 'Maximum number of matching lines to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_invoices',
      description:
        "Search invoices by customer name or invoice ref number — use this to find an invoice when you don't " +
        'know its exact number. Can filter to only invoices with a balance remaining. Does NOT search line item ' +
        "text — a serial number, part number, or shipping tracking number lives inside a line's description, not " +
        'these header fields, so use search_invoice_lines for those instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name or ref number' },
          unpaidOnly: { type: 'boolean', description: 'If true, only return invoices with a balance remaining (default false)' },
          limit: { type: 'number', description: 'Maximum number of invoices to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_invoice_lines',
      description:
        "Search invoice line items for text — use this to find a serial number, part number, shipping " +
        "tracking number, or any other text that appears in a line item's description, even if you don't know " +
        "which invoice it's on. Matches anywhere in the line description (substring, case-insensitive). Any long " +
        'alphanumeric code the user gives you (tracking numbers included) is almost always found here, not in ' +
        'search_invoices.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to search for within invoice line descriptions' },
          limit: { type: 'number', description: 'Maximum number of matching lines to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_inventory',
      description:
        'Search the inventory/product catalog by part number or description — use this for pricing questions ' +
        '("how much is X", "what does Y cost", "do we sell X") or to find a product by part number or name. ' +
        'Returns each matching product\'s price (sales_price is the current QB sales price — use that one to answer ' +
        "a pricing question; base_price/msrp/dnet_cost are separate TBWC-tracked figures and often null).",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against part number/name or description' },
          limit: { type: 'number', description: 'Maximum number of items to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_documents',
      description:
        'Search uploaded documents (attachments on orders, estimates, invoices, inventory items, etc.) by file name, ' +
        'document type, or mime type — use this when the user asks for a document, file, PDF, photo, or attachment ' +
        "by its name/type. Only matches file name/type metadata, NOT what's written inside the file — if the user " +
        'wants text found inside a document\'s contents, use search_document_contents instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against file name, doc type, or mime type' },
          limit: { type: 'number', description: 'Maximum number of documents to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_document_contents',
      description:
        'Search INSIDE the text content of uploaded documents (PDF, DOCX, XLSX, plain text) — use this when the ' +
        'user wants something found in what a file actually says, not just its name or type (e.g. "which document ' +
        'mentions serial number X", "find the PO that has this note in it", "search the load schedule for panel ' +
        'A"). Downloads and text-extracts every matching-size document to search, so it is much slower than ' +
        'search_documents — only use it when the request specifically needs file contents, and prefer ' +
        'search_documents/search_orders_by_document first when a file name or type alone would answer the question.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to search for within document contents' },
          limit: { type: 'number', description: 'Maximum number of matching documents to return (default 10)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_orders_by_document',
      description:
        'Find orders (across ALL customers) that have an attached document matching a type or file name — use ' +
        'this ONLY for "which orders have a [X] document" questions where no specific customer/order was named, ' +
        'e.g. "latest orders with a meter schedule", "orders that have a waiver on file". Matches against the ' +
        "document's type (e.g. load_schedule, panelboard_schedules, cutsheet, waiver, rma, change_order) or file " +
        'name, substring/case-insensitive — "meter schedule" matches doc type load_schedule or a file named ' +
        '"Meter Schedule.pdf" either way. Returns one row per matching order (not per document), most recently ' +
        "dated order first, UNSCOPED to any particular customer — do NOT use this to find a document for a " +
        "customer/order you already identified (e.g. via search_orders), since the top match here may belong to " +
        'a completely different customer. For "the [doc type] for [customer/order]" questions, resolve the order ' +
        'with search_orders first, then use get_order_documents with that order\'s id.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match against the document type or file name, e.g. "meter schedule"' },
          limit: { type: 'number', description: 'Maximum number of orders to return (default 5)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_estimates',
      description:
        "Search QuickBooks estimates (quotes) by customer name, estimate ref number, or sales rep — use this to " +
        "find an estimate when you don't know its exact number. An estimate is a pre-sale quote, distinct from an " +
        'order or invoice — do not use search_orders/search_invoices for "quote"/"estimate" questions.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name, ref number, or sales rep' },
          limit: { type: 'number', description: 'Maximum number of estimates to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_estimate_documents',
      description:
        'List the documents attached to ONE specific estimate, given its qb_estimate_id (from search_estimates). ' +
        'Use this whenever the user asks for a document tied to a named customer/estimate — resolve the estimate ' +
        "first with search_estimates, then call this with its id. Optionally narrow by doc type/file name text.",
      parameters: {
        type: 'object',
        properties: {
          estimateId: { type: 'number', description: "The estimate's qb_estimate_id, from a prior search_estimates result" },
          text: { type: 'string', description: 'Optional: text to match against the document type or file name within this estimate' },
        },
        required: ['estimateId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_sql_query',
      description:
        'Run a custom read-only SQL SELECT query directly against the database for analysis or data the other ' +
        'tools can\'t answer — counts, aggregates, date-range filters, joins across tables, GROUP BY, anything ' +
        'expressible as a single SELECT. Use this whenever the question needs computed/aggregated data across ' +
        'many rows (e.g. "orders not invoiced in the last 2 days", "total sales by rep this month", "average ' +
        'order value") rather than a text search for one record — the search_* tools above are for looking up ' +
        "one order/invoice/etc. by name/number, not analysis. The hints below name the tables/columns for a few " +
        "common topics, but they are NOT a complete map of the database — if a question is about a kind of data " +
        "that isn't named below, don't conclude it doesn't exist. Instead search for it first: " +
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public' AND " +
        "column_name ILIKE '%keyword%' (try a couple of synonyms, e.g. both 'discount' and 'disc') finds every " +
        'table/column whose name matches, across the whole schema, in one query. Only tell the user a figure ' +
        "isn't tracked after that search comes up empty — never after just checking the hints below.\n\n" +
        'Known tables: public.qb_sales_order (orders — also where commission data lives: commission, overage, ' +
        'and the generated commission_total = commission + overage columns, attributed via sales_rep_list_id/' +
        'sales_rep; there is NO separate commission table, so a commission question is a qb_sales_order query, ' +
        'not search_orders), public.qb_invoice (invoices — freight is NOT a column here either; it\'s its own ' +
        'line item inside the lines jsonb array, same shape search_invoice_lines searches, usually with ' +
        "item/desc containing \"Freight\" — unnest with jsonb_array_elements(lines) the way search_invoice_lines's " +
        "query does, or just call search_invoice_lines with text='freight' for a single order/customer), " +
        'public.qb_item (inventory/pricing), public.qb_estimate (quotes), public.qb_customer, public.qb_sales_rep ' +
        '(list_id, name — join qb_sales_order.sales_rep_list_id to this for a rep lookup by name), public.document ' +
        '(attachments) — most QB-synced tables soft-delete via qb_deleted_at (filter WHERE qb_deleted_at IS NULL) ' +
        "and have a txn_date column. Commission is only actually paid out once an order's invoice_status = 'Paid' " +
        '(mirrors the Rep Performance report\'s payout ledger) — for a "how much commission has X been paid" ' +
        'question filter on that; for a looser "commission on X\'s orders" question, omit the filter and say ' +
        'whether each figure is paid-only or across all orders. Only a single read-only SELECT statement is ' +
        'allowed — no semicolons, no INSERT/UPDATE/DELETE/DDL/SET/CALL/etc. Results are automatically capped at ' +
        '500 rows.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'A single read-only SELECT statement (no trailing semicolon needed).' },
        },
        required: ['sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_order_documents',
      description:
        'List the documents actually attached to ONE specific order, given its qb_sales_order_id (from ' +
        'search_orders or search_orders_by_document). Use this whenever the user asks for a document tied to a ' +
        'named customer, job, or order (e.g. "packing slip for Main Electric", "load schedule on order 51199") — ' +
        'resolve the order first with search_orders, then call this with that order\'s id so the result is ' +
        "guaranteed to belong to the right customer. Optionally narrow by doc type/file name text. Never " +
        'substitute search_documents or search_orders_by_document for this when a specific customer/order is ' +
        'already known — those search across every order and can return the wrong customer\'s document.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'number', description: "The order's qb_sales_order_id, from a prior search_orders/search_orders_by_document result" },
          text: { type: 'string', description: 'Optional: text to match against the document type or file name within this order, e.g. "packing slip"' },
        },
        required: ['orderId'],
      },
    },
  },
];

// --- Tool executor ------------------------------------------------------------

async function executeTool(env: Env, toolName: string, toolInput: Record<string, any>): Promise<string> {
  try {
    switch (toolName) {
      case 'search_orders': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT qb_sales_order_id, txn_id, ref_number, customer_name, job_name, po_number, sales_rep,
                  invoice_number, invoice_status, total, sold_for, txn_date, notes, build_notes,
                  ship_address_block, bill_address_block
           FROM public.qb_sales_order
           WHERE qb_deleted_at IS NULL
             AND (
               customer_name ILIKE '%' || $1 || '%'
               OR job_name ILIKE '%' || $1 || '%'
               OR po_number ILIKE '%' || $1 || '%'
               OR ref_number ILIKE '%' || $1 || '%'
               OR sales_rep ILIKE '%' || $1 || '%'
               OR notes ILIKE '%' || $1 || '%'
               OR build_notes ILIKE '%' || $1 || '%'
               OR ship_address_block ILIKE '%' || $1 || '%'
               OR bill_address_block ILIKE '%' || $1 || '%'
             )
           ORDER BY txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_orders'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_order_lines': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT o.qb_sales_order_id, o.txn_id, o.ref_number, o.customer_name, o.job_name, o.txn_date,
                  elem->>'item' AS item, elem->>'desc' AS description,
                  (elem->>'quantity')::numeric AS quantity,
                  (elem->>'rate')::numeric AS rate,
                  (elem->>'amount')::numeric AS amount
           FROM public.qb_sales_order o, jsonb_array_elements(o.lines) elem
           WHERE o.qb_deleted_at IS NULL
             AND elem->>'desc' ILIKE '%' || $1 || '%'
           ORDER BY o.txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_order_lines'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_estimates': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT qb_estimate_id, txn_id, ref_number, customer_name, sales_rep, total, txn_date, memo
           FROM public.qb_estimate
           WHERE customer_name ILIKE '%' || $1 || '%'
              OR ref_number ILIKE '%' || $1 || '%'
              OR sales_rep ILIKE '%' || $1 || '%'
           ORDER BY txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_estimates'
        );
        return JSON.stringify(result.rows);
      }

      case 'get_estimate_documents': {
        const estimateId = Number(toolInput.estimateId);
        if (!Number.isFinite(estimateId)) return JSON.stringify({ error: 'estimateId is required' });
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        const result = await execQuery(
          env,
          `SELECT e.qb_estimate_id, e.ref_number, e.customer_name, e.txn_date,
                  d.doc_type, d.file_name, d.document_id, d.storage_path
             FROM public.qb_estimate e
             JOIN public.document d ON d.entity_id = e.qb_estimate_id::text AND d.entity_type = 'estimate'
            WHERE e.qb_estimate_id = $1
              AND (
                $2 = ''
                OR $2 ILIKE '%' || replace(d.doc_type, '_', ' ') || '%'
                OR replace(d.doc_type, '_', ' ') ILIKE '%' || $2 || '%'
                OR d.file_name ILIKE '%' || $2 || '%'
              )
            ORDER BY d.document_id DESC`,
          [estimateId, text],
          'aiChat.get_estimate_documents'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_invoices': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const unpaidOnly = toolInput.unpaidOnly === true;
        const result = await execQuery(
          env,
          `SELECT qb_invoice_id, txn_id, ref_number, customer_name, txn_date, due_date, total, balance_remaining, is_paid
           FROM public.qb_invoice
           WHERE qb_deleted_at IS NULL
             AND (customer_name ILIKE '%' || $1 || '%' OR ref_number ILIKE '%' || $1 || '%')
             ${unpaidOnly ? "AND COALESCE(is_paid, false) = false" : ''}
           ORDER BY txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_invoices'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_invoice_lines': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT i.qb_invoice_id, i.txn_id, i.ref_number, i.customer_name, i.txn_date,
                  elem->>'item' AS item, elem->>'desc' AS description,
                  (elem->>'quantity')::numeric AS quantity,
                  (elem->>'rate')::numeric AS rate,
                  (elem->>'amount')::numeric AS amount
           FROM public.qb_invoice i, jsonb_array_elements(i.lines) elem
           WHERE i.qb_deleted_at IS NULL
             AND elem->>'desc' ILIKE '%' || $1 || '%'
           ORDER BY i.txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_invoice_lines'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_inventory': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT qb_item_id, name, full_name, sales_desc, sales_price, base_price, msrp, dnet_cost, category
           FROM public.qb_item
           WHERE qb_deleted_at IS NULL
             AND is_active = true
             AND (name ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%' OR sales_desc ILIKE '%' || $1 || '%')
           ORDER BY name ASC
           LIMIT $2`,
          [text, limit],
          'aiChat.search_inventory'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_documents': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const { matches } = await searchDocumentsMetadata(execQuery, env, text);
        return JSON.stringify(matches.slice(0, limit));
      }

      case 'search_document_contents': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 10, 50);
        const { results } = await searchDocumentsContent(execQuery, env, text);
        return JSON.stringify(results.slice(0, limit));
      }

      case 'search_orders_by_document': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 5, 100);
        const result = await execQuery(
          env,
          `SELECT qb_sales_order_id, txn_id, ref_number, customer_name, job_name, txn_date, total, doc_type, file_name, document_id, storage_path
             FROM (
               SELECT DISTINCT ON (o.qb_sales_order_id)
                      o.qb_sales_order_id, o.txn_id, o.ref_number, o.customer_name, o.job_name, o.txn_date, o.total,
                      d.doc_type, d.file_name, d.document_id, d.storage_path
                 FROM public.document d
                 JOIN public.qb_sales_order o ON o.qb_sales_order_id::text = d.entity_id
                WHERE d.entity_type = 'order'
                  AND o.qb_deleted_at IS NULL
                  AND (
                    $1 ILIKE '%' || replace(d.doc_type, '_', ' ') || '%'
                    OR replace(d.doc_type, '_', ' ') ILIKE '%' || $1 || '%'
                    OR d.file_name ILIKE '%' || $1 || '%'
                  )
                ORDER BY o.qb_sales_order_id, o.txn_date DESC NULLS LAST
             ) matched
            ORDER BY txn_date DESC NULLS LAST
            LIMIT $2`,
          [text, limit],
          'aiChat.search_orders_by_document'
        );
        return JSON.stringify(result.rows);
      }

      case 'get_order_documents': {
        const orderId = Number(toolInput.orderId);
        if (!Number.isFinite(orderId)) return JSON.stringify({ error: 'orderId is required' });
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        const result = await execQuery(
          env,
          `SELECT o.qb_sales_order_id, o.ref_number, o.customer_name, o.job_name, o.txn_date,
                  d.doc_type, d.file_name, d.document_id, d.storage_path
             FROM public.qb_sales_order o
             JOIN public.document d ON d.entity_id = o.qb_sales_order_id::text AND d.entity_type = 'order'
            WHERE o.qb_sales_order_id = $1
              AND o.qb_deleted_at IS NULL
              AND (
                $2 = ''
                OR $2 ILIKE '%' || replace(d.doc_type, '_', ' ') || '%'
                OR replace(d.doc_type, '_', ' ') ILIKE '%' || $2 || '%'
                OR d.file_name ILIKE '%' || $2 || '%'
              )
            ORDER BY d.document_id DESC`,
          [orderId, text],
          'aiChat.get_order_documents'
        );
        return JSON.stringify(result.rows);
      }

      case 'run_sql_query': {
        const raw = typeof toolInput.sql === 'string' ? toolInput.sql.trim() : '';
        if (!raw) return JSON.stringify({ error: 'sql is required' });
        const stmt = raw.replace(/;\s*$/, '');
        if (stmt.includes(';')) {
          return JSON.stringify({ error: 'Only a single statement is allowed — remove the semicolon(s).' });
        }
        if (!/^(select|with)\b/i.test(stmt)) {
          return JSON.stringify({ error: 'Only SELECT (or WITH ... SELECT) queries are allowed.' });
        }
        const blocked =
          /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|copy|call|merge|vacuum|reindex|cluster|listen|notify|refresh|lock|do|pg_sleep|dblink|pg_read_file|pg_read_binary_file|pg_write_file|lo_import|lo_export|set|reset|into)\b/i;
        const blockedMatch = stmt.match(blocked);
        if (blockedMatch) {
          return JSON.stringify({ error: `Disallowed keyword "${blockedMatch[0]}" — only read-only SELECT queries are permitted.` });
        }
        const wrapped = `SELECT * FROM (\n${stmt}\n) AS _ai_query LIMIT 500`;
        const result = await execQuery(env, wrapped, undefined, 'aiChat.run_sql_query');
        return JSON.stringify({ rowCount: result.rows.length, rows: result.rows });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${toolName}` });
    }
  } catch (err: any) {
    console.error(`[AI tool error] ${toolName}:`, err);
    return JSON.stringify({ error: err.message ?? 'Tool execution failed' });
  }
}

// --- Route --------------------------------------------------------------------

app.post('/', async (c) => {
  if (!c.env.ANTHROPIC_API_KEY) {
    return c.json({ success: false, message: 'AI chat is not configured (ANTHROPIC_API_KEY missing)' }, 503);
  }

  let body: { message?: string; history?: { role: string; content: string }[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ success: false, message: 'Invalid JSON body' }, 400);
  }

  const { message, history = [] } = body;
  if (!message || typeof message !== 'string' || !message.trim()) {
    return c.json({ success: false, message: 'message is required' }, 400);
  }

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  const claudeTools: Anthropic.ToolUnion[] = [...toClaudeTools(TOOLS), AI_MEMORY_CLAUDE_TOOL];

  const systemPrompt = `You are an AI assistant for the TBWC portal, a QuickBooks-backed sales/orders/inventory system for TBWC reps.
You have access to tools that query the live database. Use them to answer questions accurately rather than guessing.

Guidelines:
- Be concise. Your text is shown in a plain chat bubble (no markdown rendering) — never use tables, pipe characters, or markdown syntax of any kind.
- When a search tool finds results, the app already shows them below your message as clickable cards (ref number, customer, matching detail). Don't repeat that data back as a list or table — just give a one-sentence summary (e.g. "Found 3 invoices matching that serial number — see below.").
- A tracking number, serial number, or part number is line item text, not a header field — go to search_order_lines / search_invoice_lines for these directly. If you search the header tool (search_orders / search_invoices) for one of these and get nothing, ALWAYS try the matching line-item search before telling the user there's no match — do not report "not found" after only a header search.
- Pricing/product questions ("how much is X", "what does X cost", "do we carry X") are about the product catalog, not an order or invoice — use search_inventory directly. Only fall back to order/invoice line search if search_inventory finds nothing and the user seems to be asking about something on a specific past order/invoice.
- An estimate is a pre-sale QuickBooks quote, distinct from an order or invoice — a "quote" or "estimate" question uses search_estimates, never search_orders/search_invoices.
- A request for a document, file, photo, or attachment uses search_documents (file name/type only, not contents) — don't say you have no access to documents.
- If the user wants something found inside a file's actual contents (not just its name/type), use search_document_contents — you DO have access to read inside PDF/DOCX/XLSX/text files. Don't tell the user you can only search by name/type/MIME type; that's only true of search_documents, not the tool set as a whole.
- "Which orders have a [X] document" / "latest orders with a [X] attached" is about orders, not documents — use search_orders_by_document, not search_documents. It already sorts most-recent-order-first and returns one row per order.
- "The [document type] for [customer/job/order]" (a SPECIFIC customer or order was named) is a two-step lookup: resolve the order with search_orders first (customer name, job name, or address all work), then call get_order_documents with that order's qb_sales_order_id. NEVER use search_orders_by_document or search_documents for this — both search across every order regardless of customer, so their top result can easily belong to someone else. Only present a document as matching the customer/order the user asked about if you got it back from get_order_documents for that exact order's id, or you independently confirmed (e.g. via search_orders) that the order it came from is theirs — never assume a search_orders_by_document/search_documents hit is the right customer just because it matched a document type.
- Only write out details in prose when there's no search result to back it up, or when the user asks a follow-up question about one specific result.
- If nothing matches, say so plainly rather than inventing results.
- Any question needing computed/aggregated data across many rows (counts, totals, "orders not invoiced in the last N days", averages, breakdowns by rep/date/etc.) is NOT a job for the search_* tools — use run_sql_query. Never tell the user you can't answer a data question before trying run_sql_query.
- Before telling the user a figure isn't tracked/doesn't exist, you MUST have run an information_schema.columns keyword search (see run_sql_query's description) and gotten nothing back — not just checked whether it's one of the topics named in that tool's description. Those are examples, not an exhaustive list; something absent from them is very often still in the database under a name you haven't guessed yet.
- Today's date: ${new Date().toISOString().split('T')[0]}

${AI_MEMORY_GUIDELINE} Saving or recalling memory is always in scope.

${AI_CHAT_SCOPE_GUARDRAIL}`;

  try {
    const { response, toolsUsed, toolResults, outOfScope } = await runAiChatLoop(message, history as any, {
      systemPrompt,
      tools: TOOLS,
      complete: async (messages) => {
        const { system, messages: claudeMessages } = toClaudeMessages(messages);
        const res = await client.messages.create({
          model: 'claude-sonnet-5',
          max_tokens: 4096,
          system,
          thinking: { type: 'adaptive' },
          output_config: { effort: 'medium' },
          tools: claudeTools,
          messages: claudeMessages,
        });
        return fromClaudeMessage(res);
      },
      executeTool: (toolName, toolInput) =>
        toolName === AI_MEMORY_TOOL_NAME
          ? executeMemoryCommand((sql, params) => execQuery(c.env, sql, params, 'ai_memory'), null, toolInput)
          : executeTool(c.env, toolName, toolInput),
    });

    if (outOfScope) {
      return c.json(
        { success: false, message: "I can only help with questions about orders, estimates, invoices, and inventory — try rephrasing your question around those." },
        400
      );
    }

    // Forward each search tool's raw rows (not just the model's prose) so the
    // frontend can render a clickable link straight to the order/invoice it
    // found — a JSON parse failure or an error-shaped result (e.g. {error:...})
    // just drops that entry rather than failing the whole response.
    const tool_results = toolResults
      .map((tr) => {
        try {
          const parsed = JSON.parse(tr.result);
          return Array.isArray(parsed) && parsed.length > 0 ? { tool: tr.tool, data: parsed } : null;
        } catch {
          return null;
        }
      })
      .filter((tr): tr is { tool: string; data: any[] } => tr !== null);

    return c.json({ success: true, response, tools_used: toolsUsed, tool_results });
  } catch (err) {
    console.error('[AI_CHAT] loop failed:', err);
    const { status, message } = describeAiChatError(err);
    return c.json({ success: false, message }, status);
  }
});

export default app;
