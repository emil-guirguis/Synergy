/**
 * Number Helper Utilities
 *
 * Shared currency/number display formatting, reading System Config's
 * `currency` setting (Settings > System Config) by default. See systemConfig.ts.
 */
import { getSystemConfig } from './systemConfig';

/**
 * Format a value as currency using System Config's currency (default: USD).
 * Values commonly arrive as numeric strings from Postgres — coerced via Number().
 * `options` overrides Intl.NumberFormat options (e.g. `{ maximumFractionDigits: 0 }`
 * for a rounded display) while still picking up the configured currency.
 */
export function formatCurrency(
  value: number | string | null | undefined,
  options?: Intl.NumberFormatOptions
): string {
  if (value === null || value === undefined || value === '') return '';
  const amount = Number(value);
  if (isNaN(amount)) return '';

  const { currency } = getSystemConfig();
  const resolved: Intl.NumberFormatOptions = {
    style: 'currency',
    currency: currency || 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    ...options,
  };
  // A caller overriding only maximumFractionDigits (e.g. `{ maximumFractionDigits: 0 }`
  // for a rounded dashboard-card display) would otherwise leave the default
  // minimumFractionDigits: 2 in place — Intl.NumberFormat requires min <= max
  // and throws RangeError on a 2/0 pair, which silently fell through to the
  // catch below (no thousands separators, always 2 decimals) instead of
  // actually rounding. Clamp rather than require every call site to pass both.
  if (resolved.minimumFractionDigits! > resolved.maximumFractionDigits!) {
    resolved.minimumFractionDigits = resolved.maximumFractionDigits;
  }
  try {
    return new Intl.NumberFormat('en-US', resolved).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

/**
 * Format a plain number with thousands separators (no currency symbol).
 * Values commonly arrive as numeric strings from Postgres — coerced via Number().
 */
export function formatNumber(
  value: number | string | null | undefined,
  options?: Intl.NumberFormatOptions
): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  if (isNaN(n)) return '';

  return new Intl.NumberFormat('en-US', options).format(n);
}
