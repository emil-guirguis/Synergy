/**
 * Date Helper Utilities
 *
 * Common date formatting and manipulation functions.
 */
import { getSystemConfig, type SystemConfigFields } from './systemConfig';

/** A calendar date — no time, no zone. Matches both wire formats a `date` column
 *  can arrive in: the bare '2026-10-29' the APIs now send, and the zero-time instant
 *  ('2026-10-29T00:00:00.000Z') older builds produced by letting pg turn the column
 *  into a Date first. */
const CALENDAR_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T00:00:00(?:\.0+)?Z)?$/;

/** Renders y/m/d (already resolved to the zone they should display in) as a
 *  dateFormat-pattern string. Tokens: yyyy/yy, mmmm (full month name)/mmm
 *  (abbreviated)/mm/m, dd/d — case-insensitive, since stored dateFormat values vary
 *  ("MM/DD/YYYY" vs "mm/dd/yyyy"). Longer tokens are matched first so e.g. "mmmm"
 *  isn't partially consumed by the "mm" replacement. */
function renderPattern(yyyy: string, mm: string, dd: string, pattern: string): string {
  // Month names come off the same y/m/d read back in UTC, so this adds no zone of its own.
  const utc = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  const monthLong = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(utc);
  const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' }).format(utc);

  return pattern
    .replace(/yyyy/gi, yyyy)
    .replace(/yy/gi, yyyy.slice(-2))
    .replace(/mmmm/gi, monthLong)
    .replace(/mmm/gi, monthShort)
    .replace(/mm/gi, mm)
    .replace(/m(?!m)/gi, String(Number(mm)))
    .replace(/dd/gi, dd)
    .replace(/d(?!d)/gi, String(Number(dd)));
}

/** An instant (timestamp) resolved into `timeZone` (default: browser-local), then rendered. */
function formatInstant(dateObj: Date, pattern: string, timeZone?: string | null): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: timeZone || undefined,
  }).formatToParts(dateObj);
  const map: Record<string, string> = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return renderPattern(map.year, map.month, map.day, pattern);
}

/**
 * Format a date using System Config's dateFormat + timezone (Settings > System Config).
 * Pass `config` to override (e.g. in a context not yet wired to the live settings);
 * otherwise reads the current org settings.
 *
 * A calendar date (a Postgres `date` column: ship dates, order dates, due dates) is
 * rendered as the day it says, with no timezone applied. Converting one into the org's
 * timezone is what shifted every date column a day early for anyone west of UTC:
 * the day the order shipped is the same day in every zone, so there is nothing to
 * convert. Timestamps — an actual instant — still resolve into the configured zone.
 */
export function formatDate(date: Date | string | number, config?: SystemConfigFields): string {
  const { date_format, timezone } = config ?? getSystemConfig();
  const pattern = date_format || 'MM/DD/YYYY';

  if (typeof date === 'string') {
    const m = CALENDAR_DATE.exec(date.trim());
    if (m) return renderPattern(m[1], m[2], m[3], pattern);
  }

  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }

  return formatInstant(dateObj, pattern, timezone);
}

/**
 * Format a date and time using System Config's dateFormat + timeFormat + timezone.
 */
export function formatDateTime(date: Date | string | number, config?: SystemConfigFields): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }

  // formatDate(dateObj) — a Date, never the calendar-date string branch — so the
  // date half always resolves in the same zone as the time half beside it.
  return `${formatDate(dateObj, config)} ${formatTime(dateObj, config)}`;
}

/**
 * Format a date to ISO string (YYYY-MM-DD)
 */
export function formatDateISO(date: Date | string | number): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  if (isNaN(dateObj.getTime())) {
    return '';
  }
  
  return dateObj.toISOString().split('T')[0];
}

/**
 * Format a time using System Config's timeFormat (12h/24h) + timezone.
 */
export function formatTime(date: Date | string | number, config?: SystemConfigFields): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return 'Invalid Time';
  }

  const { time_format, timezone } = config ?? getSystemConfig();
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: (time_format || '12h') === '12h',
    timeZone: timezone || undefined,
  }).format(dateObj);
}

/**
 * Get relative time string (e.g., "2 hours ago", "in 3 days")
 */
export function getRelativeTime(date: Date | string | number): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  
  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }
  
  const now = new Date();
  const diffMs = now.getTime() - dateObj.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  const diffWeek = Math.floor(diffDay / 7);
  const diffMonth = Math.floor(diffDay / 30);
  const diffYear = Math.floor(diffDay / 365);
  
  if (Math.abs(diffSec) < 60) {
    return 'just now';
  } else if (Math.abs(diffMin) < 60) {
    return diffMin > 0 ? `${diffMin} minute${diffMin !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffMin)} minute${diffMin !== -1 ? 's' : ''}`;
  } else if (Math.abs(diffHour) < 24) {
    return diffHour > 0 ? `${diffHour} hour${diffHour !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffHour)} hour${diffHour !== -1 ? 's' : ''}`;
  } else if (Math.abs(diffDay) < 7) {
    return diffDay > 0 ? `${diffDay} day${diffDay !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffDay)} day${diffDay !== -1 ? 's' : ''}`;
  } else if (Math.abs(diffWeek) < 4) {
    return diffWeek > 0 ? `${diffWeek} week${diffWeek !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffWeek)} week${diffWeek !== -1 ? 's' : ''}`;
  } else if (Math.abs(diffMonth) < 12) {
    return diffMonth > 0 ? `${diffMonth} month${diffMonth !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffMonth)} month${diffMonth !== -1 ? 's' : ''}`;
  } else {
    return diffYear > 0 ? `${diffYear} year${diffYear !== 1 ? 's' : ''} ago` : `in ${Math.abs(diffYear)} year${diffYear !== -1 ? 's' : ''}`;
  }
}

/**
 * Check if a date is today
 */
export function isToday(date: Date | string | number): boolean {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const today = new Date();
  
  return (
    dateObj.getDate() === today.getDate() &&
    dateObj.getMonth() === today.getMonth() &&
    dateObj.getFullYear() === today.getFullYear()
  );
}

/**
 * Check if a date is yesterday
 */
export function isYesterday(date: Date | string | number): boolean {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  
  return (
    dateObj.getDate() === yesterday.getDate() &&
    dateObj.getMonth() === yesterday.getMonth() &&
    dateObj.getFullYear() === yesterday.getFullYear()
  );
}

/**
 * Check if a date is in the past
 */
export function isPast(date: Date | string | number): boolean {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return dateObj.getTime() < Date.now();
}

/**
 * Check if a date is in the future
 */
export function isFuture(date: Date | string | number): boolean {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;
  return dateObj.getTime() > Date.now();
}

/**
 * Add days to a date
 */
export function addDays(date: Date | string | number, days: number): Date {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : new Date(date);
  dateObj.setDate(dateObj.getDate() + days);
  return dateObj;
}

/**
 * Add months to a date
 */
export function addMonths(date: Date | string | number, months: number): Date {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : new Date(date);
  dateObj.setMonth(dateObj.getMonth() + months);
  return dateObj;
}

/**
 * Add years to a date
 */
export function addYears(date: Date | string | number, years: number): Date {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : new Date(date);
  dateObj.setFullYear(dateObj.getFullYear() + years);
  return dateObj;
}

/**
 * Get the start of day for a date
 */
export function startOfDay(date: Date | string | number): Date {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : new Date(date);
  dateObj.setHours(0, 0, 0, 0);
  return dateObj;
}

/**
 * Get the end of day for a date
 */
export function endOfDay(date: Date | string | number): Date {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : new Date(date);
  dateObj.setHours(23, 59, 59, 999);
  return dateObj;
}

/**
 * Parse a date string in various formats
 */
export function parseDate(dateString: string): Date | null {
  if (!dateString) return null;
  
  const date = new Date(dateString);
  
  if (isNaN(date.getTime())) {
    return null;
  }
  
  return date;
}
