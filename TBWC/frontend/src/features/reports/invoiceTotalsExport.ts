// CSV export for the Invoice Totals trend chart — Excel opens CSV natively,
// so this avoids pulling in a full xlsx-writer dependency (SheetJS's npm
// channel carries unpatched CVEs past 0.18.5) for what is otherwise one flat
// table.
import type { InvoiceTotalsGranularity, InvoiceTotalsTrend } from '../../types/invoiceTotals';

const PERIOD_COLUMN_LABEL: Record<InvoiceTotalsGranularity, string> = {
  day: 'Day',
  week: 'Week Starting (Fri)',
  month: 'Month',
  quarter: 'Quarter',
  year: 'Year',
  custom: 'Day',
};

function escapeCsvValue(value: string | number): string {
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export function buildTrendCsv(trend: InvoiceTotalsTrend, repLabel: string): string {
  const lines: string[] = [];
  lines.push(escapeCsvValue(`Invoice Totals — ${PERIOD_COLUMN_LABEL[trend.period]} (${repLabel})`));
  lines.push('');
  lines.push(['Period Start', 'Total', 'Invoice Count'].map(escapeCsvValue).join(','));
  for (const p of trend.points) {
    // bucketStart's date component is always correct; only trim it — the
    // time-of-day (see InvoiceTotalsPage's formatBucketLabel) is a node-postgres
    // DATE-parsing artifact (local-timezone midnight), not real data.
    lines.push([p.bucketStart.slice(0, 10), p.total.toFixed(2), p.count].map(escapeCsvValue).join(','));
  }
  // Excel needs a UTF-8 BOM to render this as text rather than guessing an
  // 8-bit codepage and mangling the em dash in the title line.
  return `﻿${lines.join('\r\n')}`;
}

export function downloadTrendCsv(trend: InvoiceTotalsTrend, repLabel: string): void {
  const csv = buildTrendCsv(trend, repLabel);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `invoice-totals-${trend.period}-${today}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
