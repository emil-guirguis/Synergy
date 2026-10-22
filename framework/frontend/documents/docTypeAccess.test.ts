import { describe, it, expect } from 'vitest';
import { DOC_TYPES, allowedDocTypes } from './types';

/** Stands in for the app's auth context: everything visible except `denied`. */
const visibility = (denied: string[]) => (_permission: string, fieldKey: string) => !denied.includes(fieldKey);

describe('allowedDocTypes', () => {
  // undefined, not the full list: DocumentsGrid takes that as "don't filter",
  // so the common (unrestricted) case costs nothing downstream.
  it('is undefined when the role denies none', () => {
    expect(allowedDocTypes(visibility([]), 'orderGridDocument:read')).toBeUndefined();
  });

  it('lists what is left when the role denies some', () => {
    const denied = ['doc_type:design', 'doc_type:change_order'];
    const allowed = allowedDocTypes(visibility(denied), 'orderGridDocument:read');
    expect(allowed).toBeDefined();
    expect(allowed).not.toContain('design');
    expect(allowed).not.toContain('change_order');
    expect(allowed).toContain('packing_slip');
    expect(allowed).toHaveLength(DOC_TYPES.length - denied.length);
  });

  // Mirrors the API: no grant at all means nothing passes isFieldVisible, and
  // an empty list is the honest answer (the grid then shows no rows, and the
  // Documents tab itself is already hidden for such a role).
  it('is an empty list when nothing is visible', () => {
    expect(allowedDocTypes(() => false, 'orderGridDocument:read')).toEqual([]);
  });

  it('asks about the permission it was given', () => {
    const seen: string[] = [];
    allowedDocTypes((permission) => { seen.push(permission); return true; }, 'quoteGridDocument:read');
    expect(new Set(seen)).toEqual(new Set(['quoteGridDocument:read']));
  });
});
