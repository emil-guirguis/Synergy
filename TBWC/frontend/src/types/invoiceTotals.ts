export type InvoiceTotalsGranularity = 'day' | 'week' | 'month' | 'quarter' | 'year' | 'custom';

/** One period's total in the Invoice Totals report. */
export interface InvoiceTotalsPeriod {
  total: number;
  count: number;
  /** ISO date (yyyy-mm-dd) — the exact range that produced this total, for the click-through to Invoices. */
  from: string;
  to: string;
}

export interface InvoiceTotalsRep {
  list_id: string;
  name: string;
}

export interface InvoiceTotalsSummary {
  period: InvoiceTotalsGranularity;
  repId: string | null;
  reps: InvoiceTotalsRep[];
  /** Current period-to-date (week/month/quarter/year, anchored to today). */
  current: InvoiceTotalsPeriod;
  /** One period back (last week/month/quarter/year), same elapsed-to-date cutoff. */
  previous: InvoiceTotalsPeriod;
  /** Same period one year earlier, same elapsed-to-date cutoff — apples-to-apples.
   *  For period="year" this is identical to `previous`. */
  priorYear: InvoiceTotalsPeriod;
}

export interface InvoiceTotalsTrendPoint {
  /** Bucket start date, ISO (bare yyyy-mm-dd or a full UTC-midnight datetime). Weekly buckets start on a Friday. */
  bucketStart: string;
  total: number;
  count: number;
}

export interface InvoiceTotalsTrend {
  period: InvoiceTotalsGranularity;
  repId: string | null;
  points: InvoiceTotalsTrendPoint[];
}
