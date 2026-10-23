/**
 * Tab/section/field assembly. The `hiddenFields` pass is what lets a form be
 * driven by the caller's role instead of a schema-side variant: the API
 * redacts a field the role can't see, so the form has to drop it rather than
 * draw an empty input — and drop a section or tab left with nothing in it.
 */
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFormTabs, type Tab } from './useFormTabs';

const TABS: Tab[] = [
  {
    name: 'Order',
    order: 1,
    sections: [{ name: 'General', order: 1, fields: [{ name: 'customer', order: 1 }, { name: 'po', order: 2 }] }],
  },
  {
    name: 'Financials',
    order: 2,
    sections: [
      { name: 'Costs', order: 1, fields: [{ name: 'total', order: 1 }, { name: 'cost', order: 2 }] },
      { name: 'Commission', order: 2, fields: [{ name: 'commission', order: 1 }] },
    ],
  },
  // Content comes from renderTabContent, not from fields.
  { name: 'Documents', order: 3, sections: [] },
];

const run = (activeTab: string, hiddenFields?: string[], hiddenTabs?: string[]) =>
  renderHook(() => useFormTabs(TABS, activeTab, null, hiddenTabs, hiddenFields)).result.current;

describe('useFormTabs', () => {
  it('keeps every tab and field with nothing hidden', () => {
    const { tabList, tabs, fieldSections } = run('Order');
    expect(tabList).toEqual(['Order', 'Financials', 'Documents']);
    expect(tabs.Financials.sections).toEqual({ Costs: ['total', 'cost'], Commission: ['commission'] });
    expect(fieldSections).toEqual({ General: ['customer', 'po'] });
  });

  it('drops a hidden field but keeps its section', () => {
    const { tabs } = run('Order', ['cost']);
    expect(tabs.Financials.sections).toEqual({ Costs: ['total'], Commission: ['commission'] });
  });

  it('drops a section once every field in it is hidden', () => {
    const { tabs } = run('Order', ['commission']);
    expect(Object.keys(tabs.Financials.sections)).toEqual(['Costs']);
  });

  it('drops the whole tab once the role can see nothing in it', () => {
    const { tabList, tabs } = run('Order', ['total', 'cost', 'commission']);
    expect(tabList).toEqual(['Order', 'Documents']);
    expect(tabs.Financials).toBeUndefined();
  });

  it('keeps a sectionless tab — its content is custom-rendered, not field-driven', () => {
    const { tabList } = run('Order', ['total', 'cost', 'commission', 'customer', 'po']);
    expect(tabList).toEqual(['Documents']);
  });

  it('falls back to the first surviving tab for fieldSections when the active one was dropped', () => {
    const { fieldSections } = run('Financials', ['total', 'cost', 'commission']);
    expect(fieldSections).toEqual({ General: ['customer', 'po'] });
  });

  it('still honours hiddenTabs and variant gates alongside hidden fields', () => {
    const { tabList } = run('Order', ['cost'], ['Documents']);
    expect(tabList).toEqual(['Order', 'Financials']);
    const gated = renderHook(() =>
      useFormTabs([{ name: 'AdminOnly', order: 1, visibleFor: ['admin'], sections: [{ name: 's', order: 1, fields: [{ name: 'f' }] }] }], 'AdminOnly', 'rep')
    ).result.current;
    expect(gated.tabList).toEqual([]);
  });
});
