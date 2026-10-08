/**
 * Date Helper Utilities
 *
 * Common date formatting and manipulation functions.
 */
import { getSystemConfig, type SystemConfigFields } from './systemConfig';

/** Renders Date parts in `timeZone` (default: browser-local) as a dateFormat-pattern string.
 *  Tokens: yyyy/yy, mmmm (full month name)/mmm (abbreviated)/mm/m, dd/d — case-insensitive,
 *  since stored dateFormat values vary ("MM/DD/YYYY" vs "mm/dd/yyyy"). Longer tokens are
 *  matched first so e.g. "mmmm" isn't partially consumed by the "mm" replacement. */
function formatDatePattern(dateObj: Date, pattern: string, timeZone?: string | null): string {
  const tz = timeZone || undefined;
  const parts = new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: tz,
  }).formatToParts(dateObj);
  const map: Record<string, string> = {};
  parts.forEach((p) => { map[p.type] = p.value; });

  const yyyy = map.year;
  const mm = map.month;
  const dd = map.day;
  const monthLong = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: tz }).format(dateObj);
  const monthShort = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: tz }).format(dateObj);

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

/**
 * Format a date using System Config's dateFormat + timezone (Settings > System Config).
 * Pass `config` to override (e.g. in a context not yet wired to the live settings);
 * otherwise reads the current org settings.
 */
export function formatDate(date: Date | string | number, config?: SystemConfigFields): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }

  const { date_format, timezone } = config ?? getSystemConfig();
  return formatDatePattern(dateObj, date_format || 'MM/DD/YYYY', timezone);
}

/**
 * Format a date and time using System Config's dateFormat + timeFormat + timezone.
 */
export function formatDateTime(date: Date | string | number, config?: SystemConfigFields): string {
  const dateObj = typeof date === 'string' || typeof date === 'number' ? new Date(date) : date;

  if (isNaN(dateObj.getTime())) {
    return 'Invalid Date';
  }

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
