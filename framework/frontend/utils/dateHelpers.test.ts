/**
 * formatDate / formatDateTime: calendar dates vs instants.
 *
 * A Postgres `date` column (ship date, order date, due date) is a calendar date —
 * no time, no zone — and must render as the day it says in every timezone. Running
 * one through the org's timezone is what showed the day BEFORE the ship date in
 * production for a config timezone west of UTC, while dev looked right because the
 * dev host's own offset happened to cancel the display conversion.
 */
import { describe, it, expect } from 'vitest';
import { formatDate, formatDateTime } from './dateHelpers';

const LA = { date_format: 'mm/dd/yyyy', timezone: 'America/Los_Angeles', time_format: '12h' as const };
const TOKYO = { date_format: 'mm/dd/yyyy', timezone: 'Asia/Tokyo', time_format: '12h' as const };

describe('formatDate — calendar dates', () => {
  it('renders a bare date as the day it says, west of UTC', () => {
    expect(formatDate('2026-10-29', LA)).toBe('10/29/2026');
  });

  it('renders the same day east of UTC', () => {
    expect(formatDate('2026-10-29', TOKYO)).toBe('10/29/2026');
  });

  it('reads a zero-time instant as that calendar date, not the day before', () => {
    // What a `date` column looked like on the wire before the worker type parser:
    // pg turned it into a Date at UTC midnight on the (UTC) Workers runtime.
    expect(formatDate('2026-10-29T00:00:00.000Z', LA)).toBe('10/29/2026');
  });

  it('reads the dev-host form of the same column as that date too', () => {
    // Same row, parsed on a host at -07:00: midnight local, 07:00 UTC.
    expect(formatDate('2026-10-29T07:00:00.000Z', LA)).toBe('10/29/2026');
  });

  it('honours the configured pattern', () => {
    expect(formatDate('2026-10-29', { ...LA, date_format: 'yyyy-mm-dd' })).toBe('2026-10-29');
    expect(formatDate('2026-10-29', { ...LA, date_format: 'mmm d, yyyy' })).toBe('Oct 29, 2026');
    expect(formatDate('2026-01-05', { ...LA, date_format: 'mmmm d, yyyy' })).toBe('January 5, 2026');
  });
});

describe('formatDate — instants', () => {
  it('still resolves a timestamp into the configured timezone', () => {
    // 01:30 UTC is still the previous evening in Los Angeles — a real instant, so
    // this one SHOULD move.
    expect(formatDate('2026-10-29T01:30:00.000Z', LA)).toBe('10/28/2026');
    expect(formatDate('2026-10-29T01:30:00.000Z', TOKYO)).toBe('10/29/2026');
  });

  it('resolves a Date the same way', () => {
    expect(formatDate(new Date('2026-10-29T01:30:00.000Z'), LA)).toBe('10/28/2026');
  });

  it('keeps the date half of a timestamp in step with its time half', () => {
    // Exactly UTC midnight: as a Date it is an instant, so both halves read in LA.
    expect(formatDateTime(new Date('2026-10-29T00:00:00.000Z'), LA)).toBe('10/28/2026 05:00 PM');
  });

  it('reports an unparseable value', () => {
    expect(formatDate('not a date', LA)).toBe('Invalid Date');
  });
});
