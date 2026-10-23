/**
 * Resources tree filtering. The lazy per-folder listing makes every root folder
 * a `loaded: false` stub with no children yet, so a filter that prunes "empty"
 * folders must not prune those — that bug showed a sales rep an empty Resources
 * page even though every file in the bucket was typed 'all'.
 */
import { describe, it, expect } from 'vitest';
import { filterCategory, filterTree } from './ResourcesTab';
import type { DocCategory, DocTree } from '../../services/storageService';

const stub = (name: string): DocCategory => ({
  name,
  path: name,
  files: [],
  subs: [],
  loaded: false,
});

describe('filterCategory', () => {
  it('keeps an unexpanded folder stub — its children are unfetched, not absent', () => {
    expect(filterCategory(stub('Cutsheets'), () => false)).toEqual({
      name: 'Cutsheets',
      path: 'Cutsheets',
      files: [],
      subs: [],
      loaded: false,
    });
  });

  it('still prunes a loaded folder nothing matched in', () => {
    const loaded: DocCategory = {
      name: 'Cutsheets',
      path: 'Cutsheets',
      files: [{ name: 'a.pdf', path: 'Cutsheets/a.pdf' }],
      subs: [],
      loaded: true,
    };
    expect(filterCategory(loaded, () => false)).toBeNull();
    expect(filterCategory(loaded, () => true)).toEqual(loaded);
  });

  it('keeps a loaded folder that only has a stub subfolder left', () => {
    const parent: DocCategory = {
      name: 'Cutsheets',
      path: 'Cutsheets',
      files: [],
      subs: [{ ...stub('2026'), path: 'Cutsheets/2026' }],
      loaded: true,
    };
    const out = filterCategory(parent, () => false);
    expect(out?.subs.map((s) => s.path)).toEqual(['Cutsheets/2026']);
  });
});

describe('filterTree', () => {
  const tree: DocTree = {
    rootFiles: [{ name: 'loose.pdf', path: 'loose.pdf' }],
    categories: [stub('Cutsheets'), stub('Pricing')],
  };

  it("'all' is a pass-through — the lazy tree survives untouched", () => {
    expect(filterTree(tree, {}, 'all')).toBe(tree);
  });

  it('a type filter keeps the unexpanded folders and filters only what is loaded', () => {
    const out = filterTree(tree, { 'loose.pdf': 'employee' }, 'rep');
    expect(out.rootFiles).toEqual([]);
    expect(out.categories.map((c) => c.name)).toEqual(['Cutsheets', 'Pricing']);
  });

  it('inherits a folder type down to its files', () => {
    const loadedTree: DocTree = {
      rootFiles: [],
      categories: [
        {
          name: 'Internal',
          path: 'Internal',
          loaded: true,
          subs: [],
          files: [{ name: 'margins.xlsx', path: 'Internal/margins.xlsx' }],
        },
      ],
    };
    expect(filterTree(loadedTree, { Internal: 'employee' }, 'rep').categories).toEqual([]);
    expect(filterTree(loadedTree, { Internal: 'rep' }, 'rep').categories).toHaveLength(1);
  });
});
