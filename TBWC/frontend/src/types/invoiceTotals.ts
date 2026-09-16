/** One period's total in the Invoice Totals report. */
export interface InvoiceTotalsPeriod {
  total: number;
  count: number;
}

export interface InvoiceTotalsRep {
  list_id: string;
  name: string;
}

export interface InvoiceTotalsSummary {
  year: number;
  years: number[];
  repId: string | null;
  reps: InvoiceTotalsRep[];
  /** Selected year, year-to-date (same day-of-year cutoff as `prior`). */
  current: InvoiceTotalsPeriod;
  /** Prior year, same day-of-year cutoff as `current` — apples-to-apples YTD. */
  prior: InvoiceTotalsPeriod;
}
