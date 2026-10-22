/**
 * The roles tree's two generic mechanisms, both driven entirely by the served
 * schema: a `perOptionAccess` select gets its own node beside Columns, with a
 * checkbox per option (which is how Order > Documents > Types works), and a
 * schema can rename its field section (how the dashboard's fields read as
 * "Cards"). Both store plain field_access view bits, so what the server
 * enforces and what this grid edits are the same keys.
 */
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockLoadSchema = vi.fn();
vi.mock('../form/utils/schemaLoader', () => ({
  loadSchema: (entity: string) => mockLoadSchema(entity),
}));

import RolesForm, { type ManagedRole, type RoleGrant } from './RolesForm';

afterEach(cleanup);

const DOC_SCHEMA = {
  formFields: {
    description: { type: 'string', label: 'Description', showOn: ['list', 'form'] },
    doc_type: {
      type: 'string',
      label: 'Type',
      showOn: ['list', 'form'],
      perOptionAccess: true,
      optionsLabel: 'Types',
      enumValues: ['packing_slip', 'design'],
      enumLabels: { packing_slip: 'Packing Slip', design: 'Design' },
    },
  },
  entityFields: {},
  formTabs: [],
  parent: { entity: 'order', label: 'Documents', actions: ['read', 'write'] },
};

/** The parent module has to be in the catalog for its child grid to nest
 *  under it (a child whose parent is absent renders at the top level). */
const ORDER_SCHEMA = {
  formFields: { ref_number: { type: 'string', label: 'SO #', showOn: ['list', 'form'] } },
  entityFields: {},
  formTabs: [],
};

const DASHBOARD_SCHEMA = {
  formFields: {
    'card:receivables': { type: 'boolean', label: 'Receivables', showOn: ['form'] },
  },
  entityFields: {},
  formTabs: [],
  fieldSectionLabel: 'Cards',
};

const role = (grants: RoleGrant[] = []): ManagedRole => ({
  role_id: 1, code: 'rep', name: 'Sales Rep', is_system: true, user_count: 2, grants,
});

const grant = (permission: string, field_access: RoleGrant['field_access'] = {}): RoleGrant => ({
  permission, scope: 'all', hidden_fields: [], field_access,
});

function setup(roles: ManagedRole[], catalog: string[]) {
  const onSaveGrants = vi.fn();
  render(
    <RolesForm
      roles={roles}
      catalog={catalog}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onSaveGrants={onSaveGrants}
      onDelete={vi.fn()}
    />
  );
  return { onSaveGrants };
}

/** Expand a collapsed tree node by its visible label. */
const expand = async (user: ReturnType<typeof userEvent.setup>, label: string | RegExp) => {
  await user.click(await screen.findByText(label));
};

/** The View checkbox on one option row (`doc_type:design`, …). */
const optionBox = async (fieldKey: string) => {
  const row = await screen.findByTestId(`role-option-${fieldKey}`);
  return row.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

beforeEach(() => {
  mockLoadSchema.mockReset();
});

describe('perOptionAccess options (Documents > Types)', () => {
  beforeEach(() => {
    mockLoadSchema.mockImplementation((entity: string) => {
      if (entity === 'orderGridDocument') return Promise.resolve(DOC_SCHEMA);
      if (entity === 'order') return Promise.resolve(ORDER_SCHEMA);
      return Promise.reject(new Error('no schema'));
    });
  });

  it('lists the options in their own node beside Columns, ticked by default', async () => {
    const user = userEvent.setup();
    setup(
      [role([grant('order:read'), grant('orderGridDocument:read')])],
      ['order:read', 'orderGridDocument:read', 'orderGridDocument:write']
    );

    await expand(user, 'Order');
    await expand(user, 'Documents');
    // Beside Columns, not inside it: Columns is still just the row's fields.
    await expand(user, 'Columns');
    expect(screen.queryByText('Packing Slip')).toBeNull();
    expect(screen.getByText('Type')).toBeTruthy();

    await expand(user, 'Types');
    expect(await screen.findByText('Packing Slip')).toBeTruthy();
    expect(screen.getByText('Design')).toBeTruthy();
    // Open by default: a grant that says nothing about the options allows them all.
    expect((await optionBox('doc_type:packing_slip')).checked).toBe(true);
    expect((await optionBox('doc_type:design')).checked).toBe(true);
  });

  it('writes the unticked option as a doc_type:<value> view bit on the read grant', async () => {
    const user = userEvent.setup();
    const { onSaveGrants } = setup(
      [role([grant('order:read'), grant('orderGridDocument:read')])],
      ['order:read', 'orderGridDocument:read', 'orderGridDocument:write']
    );

    await expand(user, 'Order');
    await expand(user, 'Documents');
    await expand(user, 'Types');
    await user.click(await optionBox('doc_type:design'));

    await user.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(onSaveGrants).toHaveBeenCalled());
    const [, grants] = onSaveGrants.mock.calls[0];
    const saved = (grants as RoleGrant[]).find((g) => g.permission === 'orderGridDocument:read')!;
    expect(saved.field_access).toEqual({ 'doc_type:design': { view: false } });
  });

  it('shows an option already denied as unticked', async () => {
    const user = userEvent.setup();
    setup(
      [role([grant('order:read'), grant('orderGridDocument:read', { 'doc_type:design': { view: false } })])],
      ['order:read', 'orderGridDocument:read']
    );

    await expand(user, 'Order');
    await expand(user, 'Documents');
    await expand(user, 'Types');
    expect((await optionBox('doc_type:design')).checked).toBe(false);
    // Its neighbours are untouched.
    expect((await optionBox('doc_type:packing_slip')).checked).toBe(true);
  });
});

describe('fieldSectionLabel (Dashboard > Cards)', () => {
  it('names the field section what the schema says instead of "Form"', async () => {
    mockLoadSchema.mockImplementation((entity: string) =>
      entity === 'dashboard' ? Promise.resolve(DASHBOARD_SCHEMA) : Promise.reject(new Error('no schema'))
    );
    const user = userEvent.setup();
    setup([role([grant('dashboard:read')])], ['dashboard:read']);

    await expand(user, 'Dashboard');
    expect(await screen.findByText('Cards')).toBeTruthy();
    expect(screen.queryByText('Form')).toBeNull();
  });
});
