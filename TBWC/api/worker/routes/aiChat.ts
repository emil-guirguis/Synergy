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
 * That full tool set is admin/employee-only (aichat:use scope 'all') — none of
 * it scopes queries to the caller's own sales rep, so a rep asking one of
 * those questions would read every rep's orders plus the whole invoice/
 * customer set. A rep (scope 'own' — migration 073) gets a completely
 * different, narrow tool set instead: the quote-creation wizard
 * (search_customers/search_catalog/create_quote/set_quote_job_name/
 * add_quote_line/get_quote, REP_TOOL_NAMES below), every call forced to their own identity and quote
 * ownership — see the scope branch in the route handler at the bottom of
 * this file.
 */
import { Hono } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { Env, execQuery, withTransaction } from '../db';
import { authenticateToken, requirePermission, AuthVariables, visibleRepListIds } from '../middleware';
import {
  runAiChatLoop,
  AiChatTool,
  describeAiChatError,
  AI_CHAT_SCOPE_GUARDRAIL,
} from '@meterit/framework-backend/api/base/aiChat';
import { checkRateLimit } from '@meterit/framework-backend/api/base/auth';
import { toClaudeTools, toClaudeMessages, fromClaudeMessage } from '../claudeChatAdapter';
import { searchTerms, prefixTerms, buildUserSearchQuery, rankUsers, type UserSearchRow } from './userSearch';
import { checkSqlQuery } from './sqlGuard';
import {
  executeMemoryCommand,
  AI_MEMORY_TOOL_NAME,
  AI_MEMORY_CLAUDE_TOOL,
  AI_MEMORY_GUIDELINE,
} from '@meterit/framework-backend/api/base/aiMemory';
import { searchDocumentsMetadata, searchDocumentsContent } from '@meterit/framework-backend/api/base/aiSearch';
import { createNotification, senderDisplayName } from '@meterit/framework-backend/api/base/notifications';
import { type DocumentHeader, type DocumentLine } from '../pdf/documentPdf';
import { dateStr, toDocumentLines, sendDocumentEmail } from '../pdf/documentEmail';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requirePermission('aichat:use'));

/** Per-user cap on AI chat calls. Every request here spends money at the model
 *  host and can fan out to several tool round trips, and the route previously
 *  had no limit of its own - a stuck client retrying, or a script holding a
 *  valid token, could run up a bill unchecked. Generous enough that ordinary
 *  use (including a fast back-and-forth in voice mode) never meets it.
 *
 *  The counter lives in the isolate, so the effective limit is per isolate
 *  rather than global - enough for cost protection, not an authorisation
 *  control (that is authenticateToken + the permission guard above). */
const AI_CHAT_MAX_REQUESTS = 40;
const AI_CHAT_WINDOW_MS = 5 * 60_000;

app.use('*', async (c, next) => {
  const user = c.get('user');
  const key = `aichat:${user?.id ?? c.req.header('cf-connecting-ip') ?? 'unknown'}`;
  if (!checkRateLimit(key, AI_CHAT_MAX_REQUESTS, AI_CHAT_WINDOW_MS)) {
    return c.json(
      { success: false, message: 'Too many AI requests in a short time - give it a minute and try again.' },
      429
    );
  }
  return next();
});


// TBWC is single-tenant — same option used by routes/notifications.ts.
const NOTIFICATION_OPTIONS = { tenantColumn: null } as const;

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
        'fields, so use search_order_lines for those instead. Set missingFinancials=true (text may be omitted) ' +
        'to list orders whose Financials tab is incomplete (Sold For, D Net Cost, or Commission not entered) — this is the ' +
        '"Missing Financials" status chip on the Orders list.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name, job name, PO number, ref number, sales rep, ship/bill address, or notes. Optional when missingFinancials is true.' },
          missingFinancials: { type: 'boolean', description: 'If true, only return orders missing Sold For or Commission on the Financials tab' },
          limit: { type: 'number', description: 'Maximum number of orders to return (default 20)' },
        },
        required: [],
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
        'Search uploaded documents (attachments on orders, quotes, invoices, inventory items, etc.) by file name, ' +
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
      name: 'search_quotes',
      description:
        "Search quotes (TBWC-local — not QuickBooks-synced) by customer name, quote ref number, or sales rep — " +
        "use this to find a quote when you don't know its exact number. A quote is a pre-sale estimate, distinct " +
        'from an order or invoice — do not use search_orders/search_invoices for "quote"/"estimate" questions.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name, ref number, or sales rep' },
          limit: { type: 'number', description: 'Maximum number of quotes to return (default 20)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quote_documents',
      description:
        'List the documents attached to ONE specific quote, given its quote_id (from search_quotes). ' +
        'Use this whenever the user asks for a document tied to a named customer/quote — resolve the quote ' +
        "first with search_quotes, then call this with its id. Optionally narrow by doc type/file name text.",
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'number', description: "The quote's quote_id, from a prior search_quotes result" },
          text: { type: 'string', description: 'Optional: text to match against the document type or file name within this quote' },
        },
        required: ['quoteId'],
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
        'public.qb_item (inventory/pricing), public.quote (quotes, TBWC-local — not QuickBooks-synced), ' +
        'public.qb_customer, public.qb_sales_rep ' +
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
  // --- Quote wizard tools --------------------------------------------------
  // The only tools a scope='own' caller (a rep — see migration 073) gets at
  // all: REP_TOOL_NAMES below gates that. Each one enforces its own rep
  // ownership server-side rather than trusting the model, same as every
  // route in this app that scopes to 'own'.
  {
    type: 'function',
    function: {
      name: 'search_customers',
      description:
        'Search QuickBooks customers by name — use this to resolve a customer the user named (e.g. by voice ' +
        'dictation) to their list_id before calling create_quote, which requires that id rather than a name.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Customer name (or part of it) to match' },
          limit: { type: 'number', description: 'Maximum number of customers to return (default 10)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_catalog',
      description:
        'Search the product catalog by part number or name to find an item and its current sales price, for ' +
        'adding to a quote via add_quote_line. Use this to resolve what the user dictated (e.g. "solar panel") ' +
        'to a real catalog item before adding it as a line — do not call add_quote_line with a guessed price ' +
        'when a catalog match exists.',
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
      name: 'create_quote',
      description:
        'Creates a new quote for the given customer. Resolve the customer with search_customers first and pass ' +
        "its list_id here. The quote's date defaults to today and its sales rep is always the caller — there is " +
        'no way to set a different rep. Returns the new quote_id — hold onto it for add_quote_line calls that follow.',
      parameters: {
        type: 'object',
        properties: {
          customerListId: { type: 'string', description: "The customer's list_id, from a search_customers result" },
        },
        required: ['customerListId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_quote_job_name',
      description:
        "Sets a quote's job name — ask for this right after create_quote returns a quote_id, before asking about " +
        "line items. Manually entered, no catalog/QuickBooks source; overwrites whatever job name the quote had.",
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'number', description: "The quote's quote_id, from create_quote" },
          jobName: { type: 'string', description: 'The job name as the user dictated it' },
        },
        required: ['quoteId', 'jobName'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_quote_line',
      description:
        'Adds one line item to a quote created by create_quote (or found via get_quote). Call once per item as ' +
        'the user dictates them — do not batch multiple items into one call. Resolve the item with search_catalog ' +
        'first and pass its qb_item_id so the price is filled in automatically (rate is only needed to override ' +
        'that price, or for a custom/non-catalog line).',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'number', description: "The quote's quote_id, from create_quote or get_quote" },
          qbItemId: { type: 'number', description: 'The catalog item\'s qb_item_id, from a search_catalog result — omit only for a custom/non-catalog line' },
          itemName: { type: 'string', description: 'Label for this line — the catalog item\'s name, or free text for a custom line' },
          description: { type: 'string', description: 'Optional line description/notes' },
          quantity: { type: 'number', description: 'Quantity being quoted' },
          rate: { type: 'number', description: 'Unit price. Omit to use the catalog item\'s current sales price (requires qbItemId) — only pass this to override it' },
        },
        required: ['quoteId', 'itemName', 'quantity'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_quote',
      description:
        "Returns a quote's customer/status/date and every line item added so far, with the running total. Use " +
        'this when the user asks what\'s on the quote so far, or to confirm it before finishing.',
      parameters: {
        type: 'object',
        properties: {
          quoteId: { type: 'number', description: "The quote's quote_id" },
        },
        required: ['quoteId'],
      },
    },
  },
  // --- Notify-a-user tools --------------------------------------------------
  {
    type: 'function',
    function: {
      name: 'search_users',
      description:
        'Search portal users (reps/employees/admins) by name or email — use this to resolve who the caller ' +
        'means before calling send_notification, which needs that user\'s id rather than a name. It matches ' +
        'each word separately and tolerates a misspelled name, so pass the name exactly as the caller ' +
        'said it and expect close matches back: if it returns someone whose name is a near-miss of what ' +
        'was asked for (asked for "Jennifer", got "Jenifer"), that IS the person - use them, and ' +
        'mention the spelling on file. Only say no such user exists when this returns nothing at all.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Name or email (or part of it) to match' },
          limit: { type: 'number', description: 'Maximum number of users to return (default 10)' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_notification',
      description:
        'Sends an in-app notification to one specific user — it shows up in their header bell. Resolve the ' +
        "user first with search_users and pass their id here; never guess an id. Use this when the caller " +
        'explicitly asks to notify/alert/message another user, not for answering ordinary questions.',
      parameters: {
        type: 'object',
        properties: {
          usersId: { type: 'string', description: "The target user's id, from a search_users result" },
          title: { type: 'string', description: 'Short notification title' },
          description: { type: 'string', description: 'Optional longer body text' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'], description: 'Defaults to info' },
        },
        required: ['usersId', 'title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_order',
      description:
        'Emails a PDF of an order to its customer (or an explicit address) — a real, external email that ' +
        "can't be recalled. Resolve the order first with search_orders and pass its qb_sales_order_id here; " +
        'never guess an id. Confirm the recipient (name/email) with the caller before calling this, unless ' +
        "they already stated it explicitly. If recipientEmail is omitted, the customer's email on file is used " +
        "— if there isn't one, this returns an error asking for an address.",
      parameters: {
        type: 'object',
        properties: {
          qbSalesOrderId: { type: 'number', description: 'From a search_orders result' },
          recipientEmail: { type: 'string', description: "Override — omit to use the customer's email on file" },
        },
        required: ['qbSalesOrderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'email_invoice',
      description:
        'Emails a PDF of an invoice to its customer (or an explicit address) — a real, external email that ' +
        "can't be recalled. Resolve the invoice first with search_invoices and pass its qb_invoice_id here; " +
        'never guess an id. Confirm the recipient (name/email) with the caller before calling this, unless ' +
        "they already stated it explicitly. If recipientEmail is omitted, the customer's email on file is used " +
        "— if there isn't one, this returns an error asking for an address.",
      parameters: {
        type: 'object',
        properties: {
          qbInvoiceId: { type: 'number', description: 'From a search_invoices result' },
          recipientEmail: { type: 'string', description: "Override — omit to use the customer's email on file" },
        },
        required: ['qbInvoiceId'],
      },
    },
  },
];

// The full-tool-set admin/employee caller is 'all'; a rep (scope 'own' —
// migration 073) only ever sees these five, so an unscoped search/run_sql_query
// tool can never surface another rep's orders/invoices/commission to them.
const REP_TOOL_NAMES = new Set(['search_customers', 'search_catalog', 'create_quote', 'set_quote_job_name', 'add_quote_line', 'get_quote']);

/** One-line caller identity for the system prompt, built server-side from the
 *  authenticated profile — never from anything in the chat message, so a
 *  caller can't impersonate someone else by typing a different name/id.
 *  Lets "me"/"my"/"I" resolve (my orders, notify me) without a search_users
 *  round trip, and answers "who am I"/"what's my rep id" directly. */
function describeCaller(user: any): string {
  const parts = [`Current user: ${senderDisplayName(user) ?? 'unknown'} (user id ${user?.id ?? 'unknown'}, email ${user?.email ?? 'unknown'})`];
  if (user?.sales_rep_name) {
    parts.push(`their sales rep identity is "${user.sales_rep_name}" (rep list id ${user.sales_rep_list_id})`);
  }
  if (Array.isArray(user?.managed_sales_rep_list_ids) && user.managed_sales_rep_list_ids.length > 0) {
    parts.push(`they manage rep list ids: ${user.managed_sales_rep_list_ids.join(', ')}`);
  }
  return `${parts.join('; ')}. When the caller refers to themselves ("me"/"my"/"I"), use these values directly — don't ask who they are or look themselves up.`;
}

// --- email_order / email_invoice helpers ----------------------------------
// escapeHtml/dateStr/toDocumentLines/uint8ToBase64/sendDocumentEmail moved to
// ../pdf/documentEmail.ts so orders.ts's POST /:id/email can reuse them too.

/** Invoices have no bill_address_block column (unlike orders) — build one
 *  from qb_customer.bill_addr (migration 001's {addr1,addr2,city,state,postal}). */
function formatInvoiceBillTo(customerName: string | null, billAddr: any): string | null {
  if (!billAddr) return customerName ?? null;
  const cityLine = [billAddr.city, billAddr.state, billAddr.postal].filter(Boolean).join(', ');
  const lines = [customerName, billAddr.addr1, billAddr.addr2, cityLine].filter(Boolean);
  return lines.length ? lines.join('\n') : customerName ?? null;
}

// --- Tool executor ------------------------------------------------------------

async function executeTool(env: Env, user: any, scope: string | null, toolName: string, toolInput: Record<string, any>): Promise<string> {
  try {
    switch (toolName) {
      case 'search_orders': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        const missingFinancials = toolInput.missingFinancials === true;
        if (!text && !missingFinancials) return JSON.stringify({ error: 'text is required (unless missingFinancials is true)' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const params: any[] = [];
        const conditions: string[] = [];
        if (text) {
          params.push(text);
          conditions.push(
            `(customer_name ILIKE '%' || $${params.length} || '%'
               OR job_name ILIKE '%' || $${params.length} || '%'
               OR po_number ILIKE '%' || $${params.length} || '%'
               OR ref_number ILIKE '%' || $${params.length} || '%'
               OR sales_rep ILIKE '%' || $${params.length} || '%'
               OR notes ILIKE '%' || $${params.length} || '%'
               OR build_notes ILIKE '%' || $${params.length} || '%'
               OR ship_address_block ILIKE '%' || $${params.length} || '%'
               OR bill_address_block ILIKE '%' || $${params.length} || '%')`
          );
        }
        // Mirrors the Orders list's "Missing Financials" chip (OrderList.tsx /
        // orders.ts CHIP_CONDITIONS.missingFinancials) — keep both in sync.
        if (missingFinancials) conditions.push('(sold_for IS NULL OR commission IS NULL OR d_net_cost IS NULL)');
        params.push(limit);
        const result = await execQuery(
          env,
          `SELECT qb_sales_order_id, txn_id, ref_number, customer_name, job_name, po_number, sales_rep,
                  invoice_number, invoice_status, total, sold_for, commission, txn_date, notes, build_notes,
                  ship_address_block, bill_address_block
           FROM public.qb_sales_order
           WHERE qb_deleted_at IS NULL
             AND ${conditions.join(' AND ')}
           ORDER BY txn_date DESC NULLS LAST
           LIMIT $${params.length}`,
          params,
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

      case 'search_quotes': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const result = await execQuery(
          env,
          `SELECT quote_id, ref_number, customer_name, sales_rep, total, txn_date, memo
           FROM public.quote
           WHERE customer_name ILIKE '%' || $1 || '%'
              OR ref_number ILIKE '%' || $1 || '%'
              OR sales_rep ILIKE '%' || $1 || '%'
           ORDER BY txn_date DESC NULLS LAST
           LIMIT $2`,
          [text, limit],
          'aiChat.search_quotes'
        );
        return JSON.stringify(result.rows);
      }

      case 'get_quote_documents': {
        const quoteId = Number(toolInput.quoteId);
        if (!Number.isFinite(quoteId)) return JSON.stringify({ error: 'quoteId is required' });
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        const result = await execQuery(
          env,
          `SELECT q.quote_id, q.ref_number, q.customer_name, q.txn_date,
                  d.doc_type, d.file_name, d.document_id, d.storage_path
             FROM public.quote q
             JOIN public.document d ON d.entity_id = q.quote_id::text AND d.entity_type = 'quote'
            WHERE q.quote_id = $1
              AND (
                $2 = ''
                OR $2 ILIKE '%' || replace(d.doc_type, '_', ' ') || '%'
                OR replace(d.doc_type, '_', ' ') ILIKE '%' || $2 || '%'
                OR d.file_name ILIKE '%' || $2 || '%'
              )
            ORDER BY d.document_id DESC`,
          [quoteId, text],
          'aiChat.get_quote_documents'
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
        // Read-only + schema checks live in sqlGuard.ts, which scans the SQL
        // with string literals and comments blanked out - the previous inline
        // scan read the raw text and rejected honest queries that merely
        // mentioned a keyword inside a quoted value.
        const guard = checkSqlQuery(toolInput.sql);
        if (!guard.ok) return JSON.stringify({ error: guard.error });
        const wrapped = `SELECT * FROM (
${guard.statement}
) AS _ai_query LIMIT 500`;
        const result = await execQuery(env, wrapped, undefined, 'aiChat.run_sql_query');
        return JSON.stringify({ rowCount: result.rows.length, rows: result.rows });
      }

      case 'search_users': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 10, 50);

        // Match word by word and rank, rather than one ILIKE on the whole
        // string: "Jennifer Crenshaw" has to find "Jenifer Crenshaw" (one n)
        // on the surname instead of reporting no such user. See userSearch.ts.
        const runSearch = async (terms: string[]) => {
          if (terms.length === 0) return [];
          const { sql, params } = buildUserSearchQuery(terms, limit);
          const result = await execQuery(env, sql, params, 'aiChat.search_users');
          return rankUsers(result.rows as UserSearchRow[], terms);
        };

        const terms = searchTerms(text);
        let users = await runSearch(terms);
        if (users.length === 0) {
          // Nothing spelled that way on file: retry on word prefixes, which
          // is what catches a misspelling in the only name given.
          users = await runSearch(prefixTerms(text));
        }
        return JSON.stringify(users.slice(0, limit));
      }

      case 'send_notification': {
        const usersId = typeof toolInput.usersId === 'string' ? toolInput.usersId.trim() : '';
        const title = typeof toolInput.title === 'string' ? toolInput.title.trim() : '';
        if (!usersId) return JSON.stringify({ error: 'usersId is required — resolve it with search_users first' });
        if (!title) return JSON.stringify({ error: 'title is required' });
        const severity = (['info', 'warning', 'error'].includes(toolInput.severity) ? toolInput.severity : 'info') as 'info' | 'warning' | 'error';
        const row = await createNotification(
          execQuery,
          env,
          null,
          {
            notificationType: 'ai_message',
            title,
            description: typeof toolInput.description === 'string' ? toolInput.description : null,
            severity,
            usersId,
            // Stamp the caller as the sender: the bell shows "From <name>", and
            // without it an AI-sent message arrives with no idea who it is from.
            createdBy: user?.id ?? null,
            createdByName: senderDisplayName(user),
          },
          NOTIFICATION_OPTIONS
        );
        return JSON.stringify({ sent: true, notification_id: row.notification_id });
      }

      case 'email_order': {
        const qbSalesOrderId = Number(toolInput.qbSalesOrderId);
        if (!Number.isFinite(qbSalesOrderId)) return JSON.stringify({ error: 'qbSalesOrderId is required — resolve it with search_orders first' });
        const explicitEmail = typeof toolInput.recipientEmail === 'string' ? toolInput.recipientEmail.trim() : '';

        const result = await execQuery(
          env,
          `SELECT o.ref_number, o.customer_name, o.job_name, o.po_number, o.txn_date, o.total,
                  o.bill_address_block, o.lines, c.email AS customer_email
             FROM public.qb_sales_order o
             LEFT JOIN public.qb_customer c ON c.list_id = o.customer_list_id AND c.qb_deleted_at IS NULL
            WHERE o.qb_sales_order_id = $1 AND o.qb_deleted_at IS NULL`,
          [qbSalesOrderId],
          'aiChat.email_order'
        );
        if (result.rows.length === 0) return JSON.stringify({ error: 'Order not found' });
        const row = result.rows[0];
        const recipientEmail = explicitEmail || row.customer_email;
        if (!recipientEmail) {
          return JSON.stringify({ error: 'No email on file for this customer — ask the caller for an address to send it to.' });
        }

        const header: DocumentHeader = {
          kind: 'Order',
          refNumber: row.ref_number,
          customerName: row.customer_name,
          billTo: row.bill_address_block,
          date: dateStr(row.txn_date),
          poNumber: row.po_number,
          jobName: row.job_name,
          total: row.total != null ? Number(row.total) : null,
        };
        return sendDocumentEmail(env, header, toDocumentLines(row.lines), recipientEmail);
      }

      case 'email_invoice': {
        const qbInvoiceId = Number(toolInput.qbInvoiceId);
        if (!Number.isFinite(qbInvoiceId)) return JSON.stringify({ error: 'qbInvoiceId is required — resolve it with search_invoices first' });
        const explicitEmail = typeof toolInput.recipientEmail === 'string' ? toolInput.recipientEmail.trim() : '';

        const result = await execQuery(
          env,
          `SELECT i.ref_number, i.customer_name, i.txn_date, i.due_date, i.total, i.lines,
                  c.email AS customer_email, c.bill_addr
             FROM public.qb_invoice i
             LEFT JOIN public.qb_customer c ON c.list_id = i.customer_list_id AND c.qb_deleted_at IS NULL
            WHERE i.qb_invoice_id = $1 AND i.qb_deleted_at IS NULL`,
          [qbInvoiceId],
          'aiChat.email_invoice'
        );
        if (result.rows.length === 0) return JSON.stringify({ error: 'Invoice not found' });
        const row = result.rows[0];
        const recipientEmail = explicitEmail || row.customer_email;
        if (!recipientEmail) {
          return JSON.stringify({ error: 'No email on file for this customer — ask the caller for an address to send it to.' });
        }

        const header: DocumentHeader = {
          kind: 'Invoice',
          refNumber: row.ref_number,
          customerName: row.customer_name,
          billTo: formatInvoiceBillTo(row.customer_name, row.bill_addr),
          date: dateStr(row.txn_date),
          secondaryDate: { label: 'Due', value: dateStr(row.due_date) },
          total: row.total != null ? Number(row.total) : null,
        };
        return sendDocumentEmail(env, header, toDocumentLines(row.lines), recipientEmail);
      }

      case 'search_customers': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 10, 50);
        const result = await execQuery(
          env,
          `SELECT list_id, full_name FROM public.qb_customer
            WHERE qb_deleted_at IS NULL AND full_name ILIKE '%' || $1 || '%'
            ORDER BY full_name ASC LIMIT $2`,
          [text, limit],
          'aiChat.search_customers'
        );
        return JSON.stringify(result.rows);
      }

      case 'search_catalog': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        // Trimmed projection vs. search_inventory — no base_price/msrp/dnet_cost,
        // same rationale as hiding d_net_cost/commission from a rep's order:read
        // (migration 040): cost figures stay off the rep-scope tool set.
        const result = await execQuery(
          env,
          `SELECT qb_item_id, name, full_name, sales_desc, sales_price
             FROM public.qb_item
            WHERE qb_deleted_at IS NULL AND is_active = true
              AND (name ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%' OR sales_desc ILIKE '%' || $1 || '%')
            ORDER BY name ASC LIMIT $2`,
          [text, limit],
          'aiChat.search_catalog'
        );
        return JSON.stringify(result.rows);
      }

      case 'create_quote': {
        const customerListId = typeof toolInput.customerListId === 'string' ? toolInput.customerListId.trim() : '';
        if (!customerListId) return JSON.stringify({ error: 'customerListId is required — resolve one with search_customers first' });
        if (!user.sales_rep_list_id) {
          return JSON.stringify({ error: "This account isn't linked to a sales rep yet — ask an admin to link it before creating quotes." });
        }
        const customer = await execQuery(
          env,
          `SELECT full_name FROM public.qb_customer WHERE list_id = $1 AND qb_deleted_at IS NULL`,
          [customerListId],
          'aiChat.create_quote.resolveCustomer'
        );
        if (!customer.rows[0]) return JSON.stringify({ error: 'Unknown customer — call search_customers again and pick one of its results' });
        const result = await execQuery(
          env,
          `INSERT INTO public.quote (customer_list_id, customer_name, txn_date, total, sales_rep_list_id, sales_rep, status)
           VALUES ($1, $2, CURRENT_DATE, 0, $3, $4, 'quote')
           RETURNING quote_id, ref_number, customer_name, sales_rep, txn_date, status`,
          [customerListId, customer.rows[0].full_name, user.sales_rep_list_id, user.sales_rep_name ?? null],
          'aiChat.create_quote'
        );
        return JSON.stringify(result.rows[0]);
      }

      case 'set_quote_job_name': {
        const quoteId = Number(toolInput.quoteId);
        if (!Number.isFinite(quoteId)) return JSON.stringify({ error: 'quoteId is required' });
        const jobName = typeof toolInput.jobName === 'string' ? toolInput.jobName.trim() : '';
        if (!jobName) return JSON.stringify({ error: 'jobName is required' });

        const quoteRows = await execQuery(
          env,
          `SELECT quote_id, sales_rep_list_id FROM public.quote WHERE quote_id = $1`,
          [quoteId],
          'aiChat.set_quote_job_name.ownerCheck'
        );
        const quote = quoteRows.rows[0];
        if (!quote) return JSON.stringify({ error: 'Quote not found' });
        if (scope === 'own' && (!quote.sales_rep_list_id || !visibleRepListIds(user).includes(quote.sales_rep_list_id))) {
          return JSON.stringify({ error: 'Quote not found' });
        }

        const result = await execQuery(
          env,
          `UPDATE public.quote SET job_name = $2 WHERE quote_id = $1 RETURNING quote_id, job_name`,
          [quoteId, jobName],
          'aiChat.set_quote_job_name'
        );
        return JSON.stringify(result.rows[0]);
      }

      case 'add_quote_line': {
        const quoteId = Number(toolInput.quoteId);
        if (!Number.isFinite(quoteId)) return JSON.stringify({ error: 'quoteId is required' });
        const itemName = typeof toolInput.itemName === 'string' ? toolInput.itemName.trim() : '';
        if (!itemName) return JSON.stringify({ error: 'itemName is required' });
        const quantity = Number(toolInput.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) return JSON.stringify({ error: 'quantity must be a positive number' });
        const qbItemId = Number.isFinite(Number(toolInput.qbItemId)) ? Number(toolInput.qbItemId) : null;
        const description = typeof toolInput.description === 'string' ? toolInput.description : null;

        const quoteRows = await execQuery(
          env,
          `SELECT quote_id, sales_rep_list_id FROM public.quote WHERE quote_id = $1`,
          [quoteId],
          'aiChat.add_quote_line.ownerCheck'
        );
        const quote = quoteRows.rows[0];
        if (!quote) return JSON.stringify({ error: 'Quote not found' });
        if (scope === 'own' && (!quote.sales_rep_list_id || !visibleRepListIds(user).includes(quote.sales_rep_list_id))) {
          return JSON.stringify({ error: 'Quote not found' });
        }

        let rate = Number.isFinite(Number(toolInput.rate)) ? Number(toolInput.rate) : null;
        if (rate === null && qbItemId !== null) {
          const priceRows = await execQuery(
            env,
            `SELECT sales_price FROM public.qb_item WHERE qb_item_id = $1`,
            [qbItemId],
            'aiChat.add_quote_line.priceLookup'
          );
          rate = Number(priceRows.rows[0]?.sales_price) || 0;
        }
        rate = rate ?? 0;
        const amount = Math.round(quantity * rate * 100) / 100;

        const quoteTotal = await withTransaction(env, async (q) => {
          const orderRow = await q(
            `SELECT COALESCE(MAX(line_order), -1) + 1 AS next_order FROM public.quote_line WHERE quote_id = $1`,
            [quoteId]
          );
          await q(
            `INSERT INTO public.quote_line (quote_id, qb_item_id, item_name, description, quantity, rate, amount, line_order)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
            [quoteId, qbItemId, itemName, description, quantity, rate, amount, orderRow.rows[0].next_order]
          );
          const totalRow = await q(
            `UPDATE public.quote SET total = COALESCE((SELECT SUM(amount) FROM public.quote_line WHERE quote_id = $1), 0)
             WHERE quote_id = $1 RETURNING total`,
            [quoteId]
          );
          return totalRow.rows[0].total;
        });

        return JSON.stringify({ quote_id: quoteId, added: { item: itemName, quantity, rate, amount }, quote_total: quoteTotal });
      }

      case 'get_quote': {
        const quoteId = Number(toolInput.quoteId);
        if (!Number.isFinite(quoteId)) return JSON.stringify({ error: 'quoteId is required' });
        const quoteRows = await execQuery(
          env,
          `SELECT quote_id, ref_number, customer_name, sales_rep, sales_rep_list_id, txn_date, status, total, job_name
             FROM public.quote WHERE quote_id = $1`,
          [quoteId],
          'aiChat.get_quote'
        );
        const quote = quoteRows.rows[0];
        if (!quote) return JSON.stringify({ error: 'Quote not found' });
        if (scope === 'own' && (!quote.sales_rep_list_id || !visibleRepListIds(user).includes(quote.sales_rep_list_id))) {
          return JSON.stringify({ error: 'Quote not found' });
        }
        delete quote.sales_rep_list_id;
        const lineRows = await execQuery(
          env,
          `SELECT item_name AS item, description AS desc, quantity, rate, amount
             FROM public.quote_line WHERE quote_id = $1 ORDER BY line_order ASC`,
          [quoteId],
          'aiChat.get_quote.lines'
        );
        return JSON.stringify({ ...quote, lines: lineRows.rows });
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

  const user = c.get('user');
  // 'own' = a rep (migration 073) — gets only the quote-wizard tools below,
  // forced to their own identity, never the unscoped admin/employee set
  // (search_orders/search_invoices/run_sql_query/etc., none of which filter
  // by rep) — see REP_TOOL_NAMES.
  const repScoped = c.get('permissions').scopeOf('aichat:use') === 'own';
  const tools = repScoped ? TOOLS.filter((t) => REP_TOOL_NAMES.has(t.function.name)) : TOOLS;

  const client = new Anthropic({ apiKey: c.env.ANTHROPIC_API_KEY });
  // The memory tool isn't rep-scoped (shared store, not partitioned per
  // caller) — keep it out of the rep tool set rather than assume its content
  // is safe for a rep who's otherwise walled off from everyone else's data.
  const claudeTools: Anthropic.ToolUnion[] = repScoped ? toClaudeTools(tools) : [...toClaudeTools(tools), AI_MEMORY_CLAUDE_TOOL];

  const systemPrompt = repScoped
    ? `You are an AI assistant for the TBWC portal. This caller is a sales rep, and the ONLY thing you can do for them here is create a quote and add line items to it — a quote-creation wizard, nothing else. You have exactly six tools: search_customers, search_catalog, create_quote, set_quote_job_name, add_quote_line, get_quote. You have NO access to orders, invoices, commission, other reps' quotes, or anything else in the system — if asked about any of that, say plainly that you can only help create quotes here.

${describeCaller(user)}

Wizard flow — follow this order, one question at a time:
1. To start a quote: resolve the customer the user named with search_customers (confirm if more than one close match), then call create_quote right away. Remember the quote_id it returns for the rest of the conversation — call create_quote only once per quote.
2. Immediately after, ask what the job name is. Once the user answers, call set_quote_job_name with that quote_id. Don't skip this or bundle it with the customer question — it's its own step, after the quote already exists.
3. Then ask what to add. For each item the user dictates, resolve it with search_catalog to get its qb_item_id and current price (unless it's clearly a custom/non-catalog line), then call add_quote_line once per item with that quote_id. Never invent a price when a catalog match exists — let add_quote_line fill it in from the catalog.
4. Keep asking "anything else?" until the user says they're done, confirming each add (item, quantity, running total) from add_quote_line's response. Use get_quote if the user asks what's on the quote so far.
5. Be concise — your text is shown in a plain chat bubble, never markdown/tables.
- Today's date: ${new Date().toISOString().split('T')[0]}

${AI_CHAT_SCOPE_GUARDRAIL}`
    : `You are an AI assistant for the TBWC portal, a QuickBooks-backed sales/orders/inventory system for TBWC reps.
You have access to tools that query the live database. Use them to answer questions accurately rather than guessing.

${describeCaller(user)}

Guidelines:
- Be concise. Your text is shown in a plain chat bubble (no markdown rendering) — never use tables, pipe characters, or markdown syntax of any kind.
- When a search tool finds results, the app already shows them below your message as clickable cards (ref number, customer, matching detail). Don't repeat that data back as a list or table — just give a one-sentence summary (e.g. "Found 3 invoices matching that serial number — see below.").
- A tracking number, serial number, or part number is line item text, not a header field — go to search_order_lines / search_invoice_lines for these directly. If you search the header tool (search_orders / search_invoices) for one of these and get nothing, ALWAYS try the matching line-item search before telling the user there's no match — do not report "not found" after only a header search.
- Pricing/product questions ("how much is X", "what does X cost", "do we carry X") are about the product catalog, not an order or invoice — use search_inventory directly. Only fall back to order/invoice line search if search_inventory finds nothing and the user seems to be asking about something on a specific past order/invoice.
- A quote is a pre-sale estimate, distinct from an order or invoice — a "quote" or "estimate" question uses search_quotes, never search_orders/search_invoices.
- To CREATE a quote (e.g. "create/start a quote for [customer]"), follow this exact sequence and nothing else: (1) call search_customers with the customer name — NEVER search_orders, search_quotes, or anything order/invoice-related to resolve the customer, that's a different lookup entirely; (2) call create_quote with the resolved customer, once; (3) ask what items to add; (4) for each item the user names, resolve it with search_catalog then call add_quote_line with that quote_id, one call per item; (5) use get_quote to confirm what's on it so far if asked. search_quotes and search_inventory are read-only lookups and can't create or change anything.
- A request for a document, file, photo, or attachment uses search_documents (file name/type only, not contents) — don't say you have no access to documents.
- If the user wants something found inside a file's actual contents (not just its name/type), use search_document_contents — you DO have access to read inside PDF/DOCX/XLSX/text files. Don't tell the user you can only search by name/type/MIME type; that's only true of search_documents, not the tool set as a whole.
- "Which orders have a [X] document" / "latest orders with a [X] attached" is about orders, not documents — use search_orders_by_document, not search_documents. It already sorts most-recent-order-first and returns one row per order.
- "The [document type] for [customer/job/order]" (a SPECIFIC customer or order was named) is a two-step lookup: resolve the order with search_orders first (customer name, job name, or address all work), then call get_order_documents with that order's qb_sales_order_id. NEVER use search_orders_by_document or search_documents for this — both search across every order regardless of customer, so their top result can easily belong to someone else. Only present a document as matching the customer/order the user asked about if you got it back from get_order_documents for that exact order's id, or you independently confirmed (e.g. via search_orders) that the order it came from is theirs — never assume a search_orders_by_document/search_documents hit is the right customer just because it matched a document type.
- Only write out details in prose when there's no search result to back it up, or when the user asks a follow-up question about one specific result.
- If nothing matches, say so plainly rather than inventing results.
- Any question needing computed/aggregated data across many rows (counts, totals, "orders not invoiced in the last N days", averages, breakdowns by rep/date/etc.) is NOT a job for the search_* tools — use run_sql_query. Never tell the user you can't answer a data question before trying run_sql_query.
- Before telling the user a figure isn't tracked/doesn't exist, you MUST have run an information_schema.columns keyword search (see run_sql_query's description) and gotten nothing back — not just checked whether it's one of the topics named in that tool's description. Those are examples, not an exhaustive list; something absent from them is very often still in the database under a name you haven't guessed yet.
- If the caller asks you to notify/alert/remind themselves ("notify me", "remind me when..."), use their own user id from "Current user" above directly — never call search_users for the caller's own name.
- If the caller asks you to notify, alert, or message another user, ALWAYS call search_users first — a bare first name (e.g. "Emil") is a complete, valid query by itself, never a reason to skip the call or assume no match. Only after calling it: if it returns exactly one person, proceed straight to send_notification with their id — don't ask for confirmation on a single unambiguous match. If it returns more than one, ask which one. If it returns zero, say so. Never tell the caller a user "can't be found" without having actually called search_users for that name. It posts to that user's in-app notification bell — it does not send an email or SMS, so say "notified" rather than "emailed"/"texted".
- If the caller asks you to email/send an order or invoice to someone, resolve it first with search_orders/search_invoices, then call email_order/email_invoice. This sends a real email with a PDF attached to an external address — it cannot be recalled — so confirm who it's going to (name or email address) before calling the tool, unless the caller already stated an explicit address themselves. If the tool reports no email on file, ask the caller for an address rather than guessing one or giving up.
- Today's date: ${new Date().toISOString().split('T')[0]}

${AI_MEMORY_GUIDELINE} Saving or recalling memory is always in scope.

${AI_CHAT_SCOPE_GUARDRAIL}`;

  try {
    const { response, toolsUsed, toolResults, outOfScope } = await runAiChatLoop(message, history as any, {
      systemPrompt,
      tools,
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
        !repScoped && toolName === AI_MEMORY_TOOL_NAME
          ? executeMemoryCommand((sql, params) => execQuery(c.env, sql, params, 'ai_memory'), null, toolInput)
          : executeTool(c.env, user, repScoped ? 'own' : 'all', toolName, toolInput),
    });

    if (outOfScope) {
      return c.json(
        {
          success: false,
          message: repScoped
            ? 'I can only help create quotes here — try asking me to start a quote or add an item.'
            : "I can only help with questions about orders, quotes, invoices, and inventory — try rephrasing your question around those.",
        },
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
