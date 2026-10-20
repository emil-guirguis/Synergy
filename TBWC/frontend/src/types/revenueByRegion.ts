/** One region's slice of the Revenue by Region report. */
export interface RevenueByRegionRow {
  region: string;
  orders: number;
  revenue: number;
  pct: number;
}

export interface RevenueByRegionSummary {
  year: number | 'all';
  years: number[];
  rows: RevenueByRegionRow[];
  totalRevenue: number;
  totalOrders: number;
}
