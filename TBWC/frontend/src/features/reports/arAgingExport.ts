// CSV export for the AR Aging table — same approach as invoiceTotalsExport:
// Excel opens CSV natively, avoiding a full xlsx-writer dependency.
import { formatDate } from '@meterit/framework-frontend/utils';
import type { ArAgingInvoice } from '../../types/arAging';

const HEADERS = [
  'Customer',
  'Amount Due',
  'Invoice #',
  'Invoice Sent',
  'Invoice Due',
  'Notice #1',
  'Notice #2',
  'Notice #3',
  'Days Since Invoice',
  'Days Past Due',
  'Average Days to Pay',
  'Fee Applied',
  'Notes',
];

function escapeCsvValue(value: string | number): string {
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const dateCell = (iso: string | null) => (iso ? formatDate(iso) : '');

export function buildArAgingCsv(rows: ArAgingInvoice[], bandLabel: string): string {
  const lines: string[] = [];
  lines.push(escapeCsvValue(`AR Aging — ${bandLabel}`));
  lines.push('');
  lines.push(HEADERS.map(escapeCsvValue).join(','));
  for (const row of rows) {
    lines.push(
      [
        row.customer_name ?? '',
        Number(row.balance_remaining ?? 0).toFixed(2),
        row.ref_number ?? '',
        dateCell(row.txn_date),
        dateCell(row.due_date),
        dateCell(row.notice_1_date),
        dateCell(row.notice_2_date),
        dateCell(row.notice_3_date),
        row.days_since_invoice ?? '',
        row.days_past_due ?? '',
        row.avg_days_to_pay ?? '',
        row.late_fee_applied ? 'Y' : '',
        row.ar_notes ?? '',
      ]
        .map(escapeCsvValue)
        .join(',')
    );
  }
  // Excel needs a UTF-8 BOM to render this as text rather than guessing an
  // 8-bit codepage and mangling the em dash in the title line.
  return `﻿${lines.join('\r\n')}`;
}

export function downloadArAgingCsv(rows: ArAgingInvoice[], bandLabel: string): void {
  const csv = buildArAgingCsv(rows, bandLabel);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `ar-aging-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
