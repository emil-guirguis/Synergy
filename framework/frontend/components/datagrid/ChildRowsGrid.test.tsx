import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChildRowsGrid, type ChildRowsApi } from './ChildRowsGrid';
import { FieldVisibilityProvider, type IsFieldVisible } from '../../auth/fieldVisibility';
import type { ConvertedSchema } from '../form/utils/schemaLoader';

// Passed as `schema`, so nothing is fetched.
const schema: ConvertedSchema = {
  entityName: 'Line', description: '', formTabs: null, relationships: {}, entityFields: {},
  idFieldName: 'line_id',
  parent: { entity: 'thing', foreignKey: 'thing_id', label: 'Lines', actions: ['read', 'create', 'write', 'delete'] },
  formFields: {
    description: { type: 'textarea', default: '', label: 'Description', showOn: ['list'] } as any,
    quantity: { type: 'number', default: 1, label: 'Qty', step: 1, showOn: ['list'] } as any,
    amount: { type: 'currency', default: 0, label: 'Amount', readOnly: true, showOn: ['list'] } as any,
    kind: { type: 'select', default: 'a', label: 'Kind', enumValues: ['a', 'b'], enumLabels: { a: 'Alpha', b: 'Beta' }, showOn: ['list'] } as any,
  },
};

const ROWS = [
  { line_id: 1, description: 'First', quantity: '2.00', amount: '20.00', kind: 'a' },
  { line_id: 2, description: 'Second', quantity: '3.00', amount: '30.00', kind: 'b' },
];

function makeApi(overrides: Partial<ChildRowsApi> = {}): ChildRowsApi {
  return {
    list: vi.fn(async () => ROWS.map((r) => ({ ...r }))),
    create: vi.fn(async (_p, body) => ({ item: { line_id: 99, ...body } })),
    update: vi.fn(async (_p, id, body) => ({ item: { ...ROWS.find((r) => r.line_id === id)!, ...body } })),
    remove: vi.fn(async () => ({})),
    ...overrides,
  };
}

const renderGrid = (props: Partial<React.ComponentProps<typeof ChildRowsGrid>> = {}) => {
  const api = props.api ?? makeApi();
  render(<ChildRowsGrid schema={schema} parentId={7} api={api} canCreate canEdit canDelete {...props} />);
  return api;
};

describe('ChildRowsGrid', () => {
  it('renders every cell as text — numbers whole (step 1), select by label, no inputs until clicked', async () => {
    renderGrid();
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument(); // '2.00' with step 1
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('only the clicked cell becomes an input', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.pointer({ keys: '[MouseLeft>]', target: await screen.findByText('First') });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getByRole('textbox')).toHaveValue('First');
  });

  it('read-only columns are not editable', async () => {
    const user = userEvent.setup();
    renderGrid();
    await user.pointer({ keys: '[MouseLeft>]', target: await screen.findByText('$20.00') });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('saves only the changed fields once focus moves to another row', async () => {
    const user = userEvent.setup();
    const api = renderGrid();
    await user.pointer({ keys: '[MouseLeft>]', target: await screen.findByText('First') });
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Edited');
    expect(api.update).not.toHaveBeenCalled(); // same row, nothing saved yet
    await user.pointer({ keys: '[MouseLeft>]', target: screen.getByText('Second') });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(7, 1, { description: 'Edited' }));
  });

  it('Escape reverts the cell and saves nothing', async () => {
    const user = userEvent.setup();
    const api = renderGrid();
    await user.pointer({ keys: '[MouseLeft>]', target: await screen.findByText('First') });
    await user.type(screen.getByRole('textbox'), ' typo');
    await user.keyboard('{Escape}');
    expect(screen.getByText('First')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 10));
    expect(api.update).not.toHaveBeenCalled();
  });

  it('without edit permission existing rows stay text; Add still works with create', async () => {
    const user = userEvent.setup();
    renderGrid({ canEdit: false });
    await user.pointer({ keys: '[MouseLeft>]', target: await screen.findByText('First') });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getAllByRole('textbox')).toHaveLength(1); // the new row's first editable cell
  });

  it('rowFilter hides rows; renderCell overrides a column and makes it non-editable', async () => {
    renderGrid({
      rowFilter: (r) => r.kind === 'a',
      renderCell: (r, col) => (col === 'description' ? <b>custom {r.line_id}</b> : undefined),
    });
    expect(await screen.findByText('custom 1')).toBeInTheDocument();
    expect(screen.queryByText('custom 2')).not.toBeInTheDocument();
  });

  it('onAddClick replaces the default blank-row add', async () => {
    const user = userEvent.setup();
    const onAddClick = vi.fn();
    renderGrid({ onAddClick });
    await screen.findByText('First');
    await user.click(screen.getByRole('button', { name: /add/i }));
    expect(onAddClick).toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('delete asks first, then calls api.remove', async () => {
    const user = userEvent.setup();
    const api = renderGrid({ deleteConfirmText: (r) => `Remove ${r.description}?` });
    await screen.findByText('First');
    await user.click(screen.getAllByRole('button', { name: /delete row/i })[0]);
    expect(screen.getByText('Remove First?')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^delete$/i }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(7, 1));
  });
});

/** A role that hides `hiddenFields` on `grant` and holds nothing else. */
function visibility(grant: string, hiddenFields: string[]): IsFieldVisible {
  return (permission, field) => permission === grant && !hiddenFields.includes(field);
}

describe('ChildRowsGrid — per-role column visibility', () => {
  const renderWith = (isFieldVisible: IsFieldVisible, props: Partial<React.ComponentProps<typeof ChildRowsGrid>> = {}) =>
    render(
      <FieldVisibilityProvider value={isFieldVisible}>
        <ChildRowsGrid
          schema={schema}
          readPermission="thingGridLine:read"
          parentId={7}
          api={makeApi()}
          totalField="amount"
          canCreate
          canEdit
          canDelete
          {...props}
        />
      </FieldVisibilityProvider>
    );

  it('shows every column outside a provider (nothing hidden)', async () => {
    renderGrid({ totalField: 'amount' });
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('Amount')).toBeInTheDocument();
    expect(screen.getByText('Total: $50.00')).toBeInTheDocument();
  });

  it('drops a column the role hides, and its footer total with it', async () => {
    renderWith(visibility('thingGridLine:read', ['amount']));
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.getByText('Qty')).toBeInTheDocument();
    expect(screen.queryByText('Amount')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Total:/)).not.toBeInTheDocument();
  });

  it('keeps the total when the summed column is visible', async () => {
    renderWith(visibility('thingGridLine:read', ['quantity']));
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(screen.queryByText('Qty')).not.toBeInTheDocument();
    expect(screen.getByText('Total: $50.00')).toBeInTheDocument();
  });

  it('derives the grant from schemaName when readPermission is not given', async () => {
    const seen: string[] = [];
    const isFieldVisible: IsFieldVisible = (permission, field) => {
      seen.push(permission);
      return field !== 'amount';
    };
    render(
      <FieldVisibilityProvider value={isFieldVisible}>
        <ChildRowsGrid schema={schema} schemaName="quoteGridLine" parentId={7} api={makeApi()} />
      </FieldVisibilityProvider>
    );
    expect(await screen.findByText('First')).toBeInTheDocument();
    expect(new Set(seen)).toEqual(new Set(['quoteGridLine:read']));
    expect(screen.queryByText('Amount')).not.toBeInTheDocument();
  });

  it('a grant the role does not hold at all hides nothing — the API, not the grid, refuses', async () => {
    renderWith(visibility('some:other', []));
    expect(await screen.findByText('First')).toBeInTheDocument();
    for (const label of ['Description', 'Qty', 'Amount', 'Kind']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
