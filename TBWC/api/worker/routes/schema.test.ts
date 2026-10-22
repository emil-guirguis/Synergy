import { describe, it, expect } from 'vitest';
import { dashboardSchema } from './dashboardSchema';
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
      'card:orderAlerts',
      'card:receivables',
      'card:repInquiries',
      'card:repStats',
      'card:revenueBacklog',
      'card:userDataGaps',
      'card:yearlyOrderTotal',
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
