import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AiChatPage as SharedAiChatPage,
  type AiChatResponse,
  type AiChatResultLink,
} from '@meterit/framework-frontend/ai-chat';
import { API_BASE_URL } from '../../config/api';
import { tokenStorage } from '../../utils/tokenStorage';
import { withAuthRetry } from '../../utils/authRetry';
import { documentsStorage } from '../../services/documentsClient';
import { useAuth } from '../../hooks/useAuth';
import { formatCurrency } from '@meterit/framework-frontend/utils';

/** Signs the stored path and opens it in a new tab — same call DocumentsGrid's
 *  own "open" action makes, just triggered from a chat result instead of a row. */
async function openFile(storagePath: string): Promise<void> {
  try {
    const url = await documentsStorage.viewUrl(storagePath);
    window.open(url, '_blank', 'noopener');
  } catch (e: any) {
    window.alert(e?.message || 'Could not open the file.');
  }
}

const SUGGESTED_QUESTIONS = [
  'Find the invoice line item with serial number 12345',
  'Which orders are for the job "Riverside Apartments"?',
  'How much is a XL-SB-ECO?',
];

// A rep's aichat:use grant is scoped 'own' (migration 073) — they get only
// the quote wizard, not the search tools above, so the page copy shouldn't
// invite questions they can't ask.
const REP_SUGGESTED_QUESTIONS = [
  'Create a quote for Riverside Apartments',
  'Add 3 XL-SB-ECO to that quote',
  "What's on the quote so far?",
];

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// Up to 8 tool-call round trips on the backend (runAiChatLoop) — a slow but
// legitimate reply can take a while. Without this, a hung backend call (e.g.
// an Anthropic API stall) left the fetch pending forever: `loading` never
// cleared, so Send and the mic button stayed disabled until a page reload.
const CHAT_TIMEOUT_MS = 60_000;

async function sendMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<AiChatResponse> {
  return withAuthRetry(async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(`${API_BASE_URL}/ai/chat`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ message, history }),
        signal: controller.signal,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') throw new Error('The AI took too long to respond. Please try again.');
      throw err;
    } finally {
      clearTimeout(timer);
    }
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.message || `HTTP ${res.status}: ${res.statusText}`);
    }
    return data;
  });
}

function formatDate(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function formatPrice(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : formatCurrency(n);
}

// AI search tools return the record's real PK (qb_sales_order_id /
// qb_invoice_id / qb_item_id — see aiChat.ts) specifically so results can
// deep-link back to the actual form instead of just being prose. Order/
// Invoice/InventoryList read the ?openId= param on mount, fetch that record,
// and open it the same way a row click does (see OrderList.tsx /
// InvoiceList.tsx / InventoryList.tsx).
//
// Each card's sublabel is a few short lines (date, then whatever matched —
// job name or the line description) rather than one run-on sentence, since
// this is meant to replace the model's old habit of restating results as a
// markdown table (which the plain chat bubble can't render anyway).
function useResultLink(): (tool: string, row: Record<string, any>) => AiChatResultLink | null {
  const navigate = useNavigate();
  return (tool, row) => {
    if (tool === 'search_orders' || tool === 'search_order_lines') {
      if (!row.qb_sales_order_id) return null;
      const lines = [formatDate(row.txn_date), row.job_name, row.description].filter(Boolean);
      return {
        label: `Order ${row.ref_number ?? row.qb_sales_order_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions: [{ label: 'Open order', onClick: () => navigate(`/orders?openId=${row.qb_sales_order_id}`) }],
      };
    }
    if (tool === 'search_quotes') {
      if (!row.quote_id) return null;
      const lines = [formatDate(row.txn_date), formatPrice(row.total)].filter(Boolean);
      return {
        label: `Quote ${row.ref_number ?? row.quote_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions: [{ label: 'Open quote', onClick: () => navigate(`/quotes?openId=${row.quote_id}`) }],
      };
    }
    if (tool === 'get_quote_documents') {
      if (!row.quote_id) return null;
      const lines = [formatDate(row.txn_date), row.doc_type ? String(row.doc_type).replace(/_/g, ' ') : null, row.file_name].filter(Boolean);
      const actions = [{ label: 'Open quote', onClick: () => navigate(`/quotes?openId=${row.quote_id}`) }];
      if (row.storage_path) actions.push({ label: 'Open file', onClick: () => void openFile(row.storage_path) });
      return {
        label: `Quote ${row.ref_number ?? row.quote_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions,
      };
    }
    if (tool === 'search_invoices' || tool === 'search_invoice_lines') {
      if (!row.qb_invoice_id) return null;
      const lines = [formatDate(row.txn_date), row.description].filter(Boolean);
      return {
        label: `Invoice ${row.ref_number ?? row.qb_invoice_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions: [{ label: 'Open invoice', onClick: () => navigate(`/invoices?openId=${row.qb_invoice_id}`) }],
      };
    }
    if (tool === 'search_orders_by_document' || tool === 'get_order_documents') {
      if (!row.qb_sales_order_id) return null;
      const lines = [formatDate(row.txn_date), row.doc_type ? String(row.doc_type).replace(/_/g, ' ') : null, row.file_name].filter(Boolean);
      const actions = [{ label: 'Open order', onClick: () => navigate(`/orders?openId=${row.qb_sales_order_id}`) }];
      if (row.storage_path) actions.push({ label: 'Open file', onClick: () => void openFile(row.storage_path) });
      return {
        label: `Order ${row.ref_number ?? row.qb_sales_order_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions,
      };
    }
    if (tool === 'search_documents') {
      const routeByEntity: Record<string, string> = { order: '/orders', quote: '/quotes', invoice: '/invoices', inventory: '/inventory' };
      const route = row.entityType ? routeByEntity[row.entityType] : undefined;
      if (!route || !row.entityId) return null;
      const lines = [row.docType ? String(row.docType).replace(/_/g, ' ') : null, row.mimeType].filter(Boolean);
      const entityLabel = row.entityType === 'order' ? 'order' : row.entityType === 'quote' ? 'quote' : row.entityType === 'invoice' ? 'invoice' : 'record';
      const actions = [{ label: `Open ${entityLabel}`, onClick: () => navigate(`${route}?openId=${row.entityId}`) }];
      if (row.storagePath) actions.push({ label: 'Open file', onClick: () => void openFile(row.storagePath) });
      return {
        label: row.fileName ?? 'Document',
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions,
      };
    }
    if (tool === 'search_document_contents') {
      const routeByEntity: Record<string, string> = { order: '/orders', quote: '/quotes', invoice: '/invoices', inventory: '/inventory' };
      const route = row.entityType ? routeByEntity[row.entityType] : undefined;
      if (!route || !row.entityId) return null;
      const lines = [row.docType ? String(row.docType).replace(/_/g, ' ') : null, row.snippet ? `…${row.snippet}…` : null].filter(Boolean);
      const entityLabel = row.entityType === 'order' ? 'order' : row.entityType === 'quote' ? 'quote' : row.entityType === 'invoice' ? 'invoice' : 'record';
      const actions = [{ label: `Open ${entityLabel}`, onClick: () => navigate(`${route}?openId=${row.entityId}`) }];
      if (row.storagePath) actions.push({ label: 'Open file', onClick: () => void openFile(row.storagePath) });
      return {
        label: row.fileName ?? 'Document',
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions,
      };
    }
    if (tool === 'search_inventory') {
      if (!row.qb_item_id) return null;
      const price = formatPrice(row.sales_price);
      const lines = [price ? `${price}${row.category ? ` — ${row.category}` : ''}` : row.category, row.sales_desc].filter(Boolean);
      return {
        label: row.full_name ?? row.name ?? `Item ${row.qb_item_id}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions: [{ label: 'Open item', onClick: () => navigate(`/inventory?openId=${row.qb_item_id}`) }],
      };
    }
    return null;
  };
}

export const AiChatPage: React.FC = () => {
  const resultLink = useResultLink();
  const { scopeOf } = useAuth();
  const repScoped = scopeOf('aichat:use') === 'own';
  return (
    <SharedAiChatPage
      sendMessage={sendMessage}
      title="AI Assistant"
      subtitle={repScoped ? 'Create a quote and dictate its line items.' : 'Ask questions about orders, quotes, invoices, and inventory.'}
      placeholder={repScoped ? 'Create a quote for...' : 'Ask about orders, quotes, invoices, inventory...'}
      emptyStateText={repScoped ? 'Tell me which customer to quote, then dictate the items to add.' : 'Ask anything about your orders, quotes, invoices, and inventory.'}
      suggestedQuestions={repScoped ? REP_SUGGESTED_QUESTIONS : SUGGESTED_QUESTIONS}
      resultLink={resultLink}
    />
  );
};

export default AiChatPage;
