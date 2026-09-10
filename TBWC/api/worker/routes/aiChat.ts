/**
 * AI Chat route — Cloudflare Worker.
 *
 * POST /api/ai/chat
 * Body: { message: string, history?: { role: 'user' | 'assistant', content: string }[] }
 *
 * Uses Groq (llama-3.3-70b) with tool use, same shared agentic loop as
 * MeterItPro's aiChat.ts (see @meterit/framework-backend/api/base/aiChat).
 * Tool set is TBWC-specific — order/invoice header search (customer, job
 * name, PO, notes, ref number) plus line-item search on both, which lets a
 * rep find a serial/part number without knowing which order or invoice it's
 * on (qb_sales_order.lines / qb_invoice.lines are jsonb arrays; a serial
 * number lives free-text inside a line's `desc`, not its own column, so line
 * search is jsonb_array_elements + ILIKE, not an exact-match query) — plus
 * inventory/product-catalog search (public.qb_item, pricing questions).
 *
 * Admin-only. None of the tools below scope their queries to the caller's own
 * sales rep, so a rep asking a question would read every rep's orders plus the
 * whole invoice/customer set — the rest of the rep portal is scoped to their
 * own rep_id. The Ask AI nav item and /ai-chat route are admin-gated to match.
 */
import { Hono } from 'hono';
import OpenAI from 'openai';
import { Env, execQuery } from '../db';
import { authenticateToken, requireAdmin, AuthVariables } from '../middleware';
import { runAiChatLoop, AiChatMessage, describeAiChatError } from '@meterit/framework-backend/api/base/aiChat';

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authenticateToken);
app.use('*', requireAdmin);

// --- Tool definitions ---------------------------------------------------------

const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'search_orders',
      description:
        "Search sales orders by customer name, job name, PO number, order ref number, sales rep, or notes/build " +
        "notes text — use this to find an order when you don't know its exact order number, e.g. by job site or a note. " +
        "Does NOT search line item text — a serial number, part number, or shipping tracking number lives inside a " +
        'line\'s description, not these header fields, so use search_order_lines for those instead.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to match (substring, case-insensitive) against customer name, job name, PO number, ref number, sales rep, or notes' },
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
                  invoice_number, invoice_status, total, sold_for, txn_date, notes, build_notes
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

      case 'search_invoices': {
        const text = typeof toolInput.text === 'string' ? toolInput.text.trim() : '';
        if (!text) return JSON.stringify({ error: 'text is required' });
        const limit = Math.min(toolInput.limit ?? 20, 100);
        const unpaidOnly = toolInput.unpaidOnly === true;
        const result = await execQuery(
          env,
          `SELECT qb_invoice_id, txn_id, ref_number, customer_name, txn_date, due_date, total, balance_remaining, is_paid
           FROM public.qb_invoice
           WHERE (customer_name ILIKE '%' || $1 || '%' OR ref_number ILIKE '%' || $1 || '%')
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
           WHERE elem->>'desc' ILIKE '%' || $1 || '%'
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
           WHERE is_active = true
             AND (name ILIKE '%' || $1 || '%' OR full_name ILIKE '%' || $1 || '%' OR sales_desc ILIKE '%' || $1 || '%')
           ORDER BY name ASC
           LIMIT $2`,
          [text, limit],
          'aiChat.search_inventory'
        );
        return JSON.stringify(result.rows);
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
  if (!c.env.GROQ_API_KEY) {
    return c.json({ success: false, message: 'AI chat is not configured (GROQ_API_KEY missing)' }, 503);
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

  const client = new OpenAI({
    apiKey: c.env.GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });

  const systemPrompt = `You are an AI assistant for the TBWC portal, a QuickBooks-backed sales/orders/inventory system for TBWC reps.
You have access to tools that query the live database. Use them to answer questions accurately rather than guessing.

Guidelines:
- Be concise. Your text is shown in a plain chat bubble (no markdown rendering) — never use tables, pipe characters, or markdown syntax of any kind.
- When a search tool finds results, the app already shows them below your message as clickable cards (ref number, customer, matching detail). Don't repeat that data back as a list or table — just give a one-sentence summary (e.g. "Found 3 invoices matching that serial number — see below.").
- A tracking number, serial number, or part number is line item text, not a header field — go to search_order_lines / search_invoice_lines for these directly. If you search the header tool (search_orders / search_invoices) for one of these and get nothing, ALWAYS try the matching line-item search before telling the user there's no match — do not report "not found" after only a header search.
- Pricing/product questions ("how much is X", "what does X cost", "do we carry X") are about the product catalog, not an order or invoice — use search_inventory directly. Only fall back to order/invoice line search if search_inventory finds nothing and the user seems to be asking about something on a specific past order/invoice.
- Only write out details in prose when there's no search result to back it up, or when the user asks a follow-up question about one specific result.
- If nothing matches, say so plainly rather than inventing results.
- Today's date: ${new Date().toISOString().split('T')[0]}`;

  try {
    const { response, toolsUsed, toolResults } = await runAiChatLoop(message, history as any, {
      systemPrompt,
      tools: TOOLS as any,
      complete: async (messages) => {
        // Groq retired llama-3.3-70b-versatile (404s as of 2026-09-09, confirmed
        // via GET /v1/models) — gpt-oss-120b is the current tool-calling model.
        const res = await client.chat.completions.create({
          model: 'openai/gpt-oss-120b',
          messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
          tools: TOOLS,
          tool_choice: 'auto',
        });
        return res.choices[0].message as unknown as AiChatMessage;
      },
      executeTool: (toolName, toolInput) => executeTool(c.env, toolName, toolInput),
    });

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
