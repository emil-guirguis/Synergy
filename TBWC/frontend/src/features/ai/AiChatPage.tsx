import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AiChatPage as SharedAiChatPage,
  type AiChatResponse,
  type AiChatResultLink,
} from '@meterit/framework-frontend/ai-chat';
import { API_BASE_URL } from '../../config/api';
import { tokenStorage } from '../../utils/tokenStorage';
import { documentsStorage } from '../../services/documentsClient';

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

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = tokenStorage.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function sendMessage(
  message: string,
  history: { role: 'user' | 'assistant'; content: string }[]
): Promise<AiChatResponse> {
  const res = await fetch(`${API_BASE_URL}/ai/chat`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ message, history }),
  });
  const data = await res.json();
  if (!res.ok && !data.message) {
    throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  }
  return data;
}

function formatDate(value: unknown): string | null {
  if (!value || typeof value !== 'string') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function formatPrice(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : `$${n.toFixed(2)}`;
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
    if (tool === 'search_estimates') {
      if (!row.qb_estimate_id) return null;
      const lines = [formatDate(row.txn_date), formatPrice(row.total)].filter(Boolean);
      return {
        label: `Estimate ${row.ref_number ?? row.qb_estimate_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions: [{ label: 'Open estimate', onClick: () => navigate(`/estimates?openId=${row.qb_estimate_id}`) }],
      };
    }
    if (tool === 'get_estimate_documents') {
      if (!row.qb_estimate_id) return null;
      const lines = [formatDate(row.txn_date), row.doc_type ? String(row.doc_type).replace(/_/g, ' ') : null, row.file_name].filter(Boolean);
      const actions = [{ label: 'Open estimate', onClick: () => navigate(`/estimates?openId=${row.qb_estimate_id}`) }];
      if (row.storage_path) actions.push({ label: 'Open file', onClick: () => void openFile(row.storage_path) });
      return {
        label: `Estimate ${row.ref_number ?? row.qb_estimate_id} — ${row.customer_name ?? 'Unknown customer'}`,
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
      const routeByEntity: Record<string, string> = { order: '/orders', estimate: '/estimates', invoice: '/invoices', inventory: '/inventory' };
      const route = row.entityType ? routeByEntity[row.entityType] : undefined;
      if (!route || !row.entityId) return null;
      const lines = [row.docType ? String(row.docType).replace(/_/g, ' ') : null, row.mimeType].filter(Boolean);
      const entityLabel = row.entityType === 'order' ? 'order' : row.entityType === 'estimate' ? 'estimate' : row.entityType === 'invoice' ? 'invoice' : 'record';
      const actions = [{ label: `Open ${entityLabel}`, onClick: () => navigate(`${route}?openId=${row.entityId}`) }];
      if (row.storagePath) actions.push({ label: 'Open file', onClick: () => void openFile(row.storagePath) });
      return {
        label: row.fileName ?? 'Document',
        sublabel: lines.length ? lines.join('\n') : undefined,
        actions,
      };
    }
    if (tool === 'search_document_contents') {
      const routeByEntity: Record<string, string> = { order: '/orders', estimate: '/estimates', invoice: '/invoices', inventory: '/inventory' };
      const route = row.entityType ? routeByEntity[row.entityType] : undefined;
      if (!route || !row.entityId) return null;
      const lines = [row.docType ? String(row.docType).replace(/_/g, ' ') : null, row.snippet ? `…${row.snippet}…` : null].filter(Boolean);
      const entityLabel = row.entityType === 'order' ? 'order' : row.entityType === 'estimate' ? 'estimate' : row.entityType === 'invoice' ? 'invoice' : 'record';
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
  return (
    <SharedAiChatPage
      sendMessage={sendMessage}
      title="AI Assistant"
      subtitle="Ask questions about orders, estimates, invoices, and inventory."
      placeholder="Ask about orders, estimates, invoices, inventory..."
      emptyStateText="Ask anything about your orders, estimates, invoices, and inventory."
      suggestedQuestions={SUGGESTED_QUESTIONS}
      resultLink={resultLink}
    />
  );
};

export default AiChatPage;
