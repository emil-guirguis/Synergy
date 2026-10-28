import { describe, it, expect } from 'vitest';
import { noticeNumberOf, todayLocal, telHrefFor } from './noticeActions';

describe('noticeNumberOf', () => {
  it('reads the notice number off the AR tab section names', () => {
    expect(noticeNumberOf('1st Notice')).toBe(1);
    expect(noticeNumberOf('2nd Notice')).toBe(2);
    expect(noticeNumberOf('3rd Notice')).toBe(3);
  });

  it('ignores every other section on the form', () => {
    for (const name of ['Customer Payment History', 'Collections', 'Notes', 'Identity', 'Totals']) {
      expect(noticeNumberOf(name)).toBeNull();
    }
  });
});

describe('todayLocal', () => {
  it('formats the local date as YYYY-MM-DD', () => {
    expect(todayLocal(new Date(2026, 9, 7, 9, 30))).toBe('2026-10-07');
  });

  it('stays on today late in the evening, where a UTC date would roll over', () => {
    // 11pm local on the 7th is already the 8th in UTC anywhere west of
    // Greenwich — the notice was still sent on the 7th.
    const late = new Date(2026, 9, 7, 23, 59);
    expect(todayLocal(late)).toBe('2026-10-07');
  });
});

describe('telHrefFor', () => {
  it('strips every QB phone format down to digits', () => {
    expect(telHrefFor('(951) 271-8200')).toBe('tel:9512718200');
    expect(telHrefFor('951-683-6625')).toBe('tel:9516836625');
    expect(telHrefFor('909 974 0111')).toBe('tel:9099740111');
  });

  it('keeps an extension the customer actually stored', () => {
    expect(telHrefFor('951-683-6625 x204')).toBe('tel:9516836625204');
  });

  it('is null for a number too short to dial', () => {
    expect(telHrefFor('x204')).toBeNull();
    expect(telHrefFor('555-1234')).toBeNull();
    expect(telHrefFor(null)).toBeNull();
  });
});
