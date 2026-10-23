/**
 * Column widths derived from field types instead of written out per grid.
 *
 * Every line-item grid used to carry its own hardcoded width table — and a
 * second one for "same grid, minus the money columns", because dropping two
 * columns from a fixed set leaves the rest squeezed into part of the table.
 * Normalising weights removes both: whatever subset of columns a role can see
 * fills the width.
 */

/** Relative share per schema field type — a catalog description needs the room, a quantity doesn't. */
export const COLUMN_TYPE_WEIGHT: Record<string, number> = {
  textarea: 4,
  string: 1.6,
  select: 1.6,
  currency: 1.5,
  number: 1,
  date: 1.2,
  boolean: 0.8,
};

export const DEFAULT_COLUMN_WEIGHT = 1.5;

/** Percentage width per column, in the order given, summing to 100%. */
export function weightedWidths(types: (string | undefined)[]): string[] {
  const weights = types.map((t) => (t && COLUMN_TYPE_WEIGHT[t]) || DEFAULT_COLUMN_WEIGHT);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map((w) => `${((w / total) * 100).toFixed(2)}%`);
}
