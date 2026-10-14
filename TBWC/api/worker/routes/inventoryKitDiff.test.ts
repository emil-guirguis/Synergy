import { describe, it, expect, vi } from 'vitest';

vi.mock('../db', () => ({ execQuery: vi.fn(), withTransaction: vi.fn() }));

import { diffKitItems } from './inventory';

const row = (item_id: number, extra: Record<string, any> = {}) =>
  ({ item_id, group_id: null, group_desc: null, qty: 1, required: true, ...extra });

describe('diffKitItems (inventoryGridKitItem create/delete/write split)', () => {
  const stored = [row(1), row(2, { qty: '2.00' }), row(3)];

  it('identical list -> nothing', () => {
    expect(diffKitItems(stored, [row(1), row(2, { qty: 2 }), row(3)])).toEqual({ added: false, removed: false, changed: false });
  });

  it('appending a line is only an add', () => {
    expect(diffKitItems(stored, [row(1), row(2, { qty: 2 }), row(3), row(4)])).toEqual({ added: true, removed: false, changed: false });
  });

  it('removing a middle line is only a remove (order_by renumbering is not an edit)', () => {
    expect(diffKitItems(stored, [row(1), row(3)])).toEqual({ added: false, removed: true, changed: false });
  });

  it('qty / required / group changes are edits', () => {
    expect(diffKitItems(stored, [row(1), row(2, { qty: 5 }), row(3)]).changed).toBe(true);
    expect(diffKitItems(stored, [row(1, { required: false }), row(2, { qty: 2 }), row(3)]).changed).toBe(true);
    expect(diffKitItems(stored, [row(1, { group_id: 1, group_desc: 'CTs' }), row(2, { qty: 2 }), row(3)]).changed).toBe(true);
  });

  it('a drag reorder is an edit', () => {
    expect(diffKitItems(stored, [row(3), row(1), row(2, { qty: 2 })])).toEqual({ added: false, removed: false, changed: true });
  });

  it('the same item twice matches occurrence by occurrence', () => {
    const twice = [row(7), row(7)];
    expect(diffKitItems(twice, [row(7)])).toEqual({ added: false, removed: true, changed: false });
    expect(diffKitItems(twice, [row(7), row(7), row(7)])).toEqual({ added: true, removed: false, changed: false });
  });
});
