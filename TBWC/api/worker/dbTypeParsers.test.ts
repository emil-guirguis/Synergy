/**
 * The pg type parsers db.ts installs keep the HOST's timezone out of values that
 * don't carry one. Without them the same row serializes differently on a dev laptop
 * (-07:00) than on the Workers runtime (UTC) — which is how the Orders list came to
 * show the day before the ship date in production only (2026-10-30).
 */
import { describe, it, expect } from 'vitest';
import { types } from 'pg';
import './db';

describe('db.ts pg type parsers', () => {
  it('hands a date column back as the wire text, with no zone applied', () => {
    const parse = types.getTypeParser(types.builtins.DATE, 'text' as any);
    expect(parse('2026-10-29')).toBe('2026-10-29');
  });

  it('reads a zone-less timestamp as UTC, not as host-local time', () => {
    const parse = types.getTypeParser(types.builtins.TIMESTAMP, 'text' as any);
    expect(new Date(parse('2026-10-29 13:45:00')).toISOString()).toBe('2026-10-29T13:45:00.000Z');
  });
});
