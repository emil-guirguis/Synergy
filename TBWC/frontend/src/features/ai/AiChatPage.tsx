import React from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AiChatPage as SharedAiChatPage,
  type AiChatResponse,
  type AiChatResultLink,
} from '@meterit/framework-frontend/ai-chat';
import { API_BASE_URL } from '../../config/api';
import { tokenStorage } from '../../utils/tokenStorage';

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
        onClick: () => navigate(`/orders?openId=${row.qb_sales_order_id}`),
      };
    }
    if (tool === 'search_invoices' || tool === 'search_invoice_lines') {
      if (!row.qb_invoice_id) return null;
      const lines = [formatDate(row.txn_date), row.description].filter(Boolean);
      return {
        label: `Invoice ${row.ref_number ?? row.qb_invoice_id} — ${row.customer_name ?? 'Unknown customer'}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        onClick: () => navigate(`/invoices?openId=${row.qb_invoice_id}`),
      };
    }
    if (tool === 'search_inventory') {
      if (!row.qb_item_id) return null;
      const price = formatPrice(row.sales_price);
      const lines = [price ? `${price}${row.category ? ` — ${row.category}` : ''}` : row.category, row.sales_desc].filter(Boolean);
      return {
        label: row.full_name ?? row.name ?? `Item ${row.qb_item_id}`,
        sublabel: lines.length ? lines.join('\n') : undefined,
        onClick: () => navigate(`/inventory?openId=${row.qb_item_id}`),
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
      subtitle="Ask questions about orders, invoices, and inventory."
      placeholder="Ask about orders, invoices, inventory..."
      emptyStateText="Ask anything about your orders, invoices, and inventory."
      suggestedQuestions={SUGGESTED_QUESTIONS}
      resultLink={resultLink}
    />
  );
};

export default AiChatPage;
