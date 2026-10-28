import { describe, it, expect } from 'vitest';
import { dashboardSchema } from './dashboardSchema';
import { orderSchema } from './orderSchema';
import { CHILD_SCHEMAS } from '../permissions';

// What Settings > Roles renders for a module comes from the schema it serves,
// so these are the two schema shapes the roles tree depends on structurally —
// a rename here silently empties a node there.
describe('dashboard schema (roles tree: Dashboard > Cards)', () => {
  const json = dashboardSchema.toJSON();

  it('names its field list "Cards" rather than "Form"', () => {
    expect(json.fieldSectionLabel).toBe('Cards');
  });

  // The ids DashboardPage checks with isFieldVisible('dashboard:read', ...).
  it('carries one card:<id> field per dashboard card', () => {
    expect(Object.keys(json.formFields).sort()).toEqual([
      'card:orderStatus',
      'card:repInquiries',
      'card:repStats',
      'card:supportTickets',
    ]);
  });

  // Nothing here is a column and nothing is saved — the schema exists only so
  // the roles tree has something to list.
  it('maps no card to a database column', () => {
    for (const def of Object.values(json.formFields) as any[]) {
      expect(def.dbField).toBeNull();
    }
  });

  it('labels every card for the roles tree', () => {
    for (const def of Object.values(json.formFields) as any[]) {
      expect(def.label).toBeTruthy();
      expect(def.description).toBeTruthy();
    }
  });
});

describe('document grid schemas (roles tree: <Module> > Documents > Type)', () => {
  const docGridKeys = Object.keys(CHILD_SCHEMAS).filter((k) => k.endsWith('GridDocument'));

  it('exist for every module with a Documents tab', () => {
    expect(docGridKeys.sort()).toEqual([
      'inventoryGridDocument',
      'invoiceGridDocument',
      'orderGridDocument',
      'quoteGridDocument',
      'supportGridDocument',
    ]);
  });

  // perOptionAccess is what makes the roles tree render a checkbox per type;
  // the route enforces the same keys via allowedOptions().
  it('declare doc_type as per-option access-controlled, with every type', () => {
    for (const key of docGridKeys) {
      const docType = (CHILD_SCHEMAS as any)[key].toJSON().formFields.doc_type;
      expect(docType.perOptionAccess, key).toBe(true);
      expect(docType.enumValues, key).toContain('packing_slip');
      expect(docType.enumValues, key).toContain('design');
      expect(Object.keys(docType.enumLabels).length, key).toBe(docType.enumValues.length);
    }
  });
});

describe('order schema tabs (roles tree: Order > Fields > <tab>)', () => {
  const tabs = orderSchema.toJSON().formTabs as any[];
  const tabNamed = (name: string) => tabs.find((t) => t.name === name);

  // A tab carrying visibleFor is filtered out by BaseForm's variant before the
  // role's own tab:<Name> bit is consulted, and RolesForm can only ever persist
  // a denial — so a variant-gated tab can be taken away by a role but never
  // switched back on. Any tab meant to be role-controlled must not carry one.
  it('gates no field by variant either', () => {
    // Fields carry visibleFor in two places once serialised: the formFields
    // entry and the tab's own field ref. Neither may have one — a gated field
    // can be taken from a role but never granted to it (RolesForm writes
    // denials only), so ticking it in Settings > Roles would do nothing.
    for (const [name, def] of Object.entries(orderSchema.toJSON().formFields) as [string, any][]) {
      expect(def.visibleFor, name).toBeFalsy();
    }
    for (const tab of tabs) {
      for (const section of tab.sections ?? []) {
        expect(section.visibleFor, `${tab.name} > ${section.name}`).toBeFalsy();
        for (const ref of section.fields ?? []) {
          expect(ref.visibleFor, `${tab.name} > ${section.name} > ${ref.name}`).toBeFalsy();
        }
      }
    }
  });

  it('gates no tab by variant — each one is up to the role grant', () => {
    // toJSON() serialises an absent visibleFor as null; useFormTabs treats
    // null/empty as "show to every variant", which is the point. Financials
    // included: what a rep sees in there is per-field (migrations 040/113),
    // and BaseForm's fieldPermission drops the fields their grant hides.
    for (const tab of tabs) {
      expect(tab.visibleFor, tab.name).toBeFalsy();
    }
    expect(tabs.map((t) => t.name)).toContain('Serial Numbers');
  });

  it('gives every tab a name the roles tree can address as tab:<Name>', () => {
    for (const tab of tabs) {
      expect(tab.name).toBeTruthy();
      expect(tab.sections.length, tab.name).toBeGreaterThan(0);
    }
  });
});
