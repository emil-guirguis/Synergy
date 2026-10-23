/**
 * Columns (labels, order, widths, whether they appear at all) come from the
 * schema and the caller's role — never a list written into the component.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PickableLineItemsGrid, type LineItemPickerConfig } from './PickableLineItemsGrid';
import { weightedWidths } from './columnLayout';
import { FieldVisibilityProvider, type IsFieldVisible } from '../../auth/fieldVisibility';

const itemSearch = { endpoint: '/inventory', valueField: 'list_id', labelField: 'full_name', searchFields: ['full_name'] } as any;
const config: LineItemPickerConfig = {
  itemSearch,
  descField: 'desc',
  quantityField: 'quantity',
  rateField: 'rate',
};

const SCHEMA = {
  formFields: {
    item: { type: 'string', label: 'Part', showOn: ['list'] },
    desc: { type: 'textarea', label: 'What it is', showOn: ['list'] },
    quantity: { type: 'number', label: 'How many', showOn: ['list'] },
    rate: { type: 'currency', label: 'Unit price', showOn: ['list'] },
    amount: { type: 'currency', label: 'Extended', showOn: ['list'] },
  },
};

const mockUseSchema = vi.fn(() => ({ schema: SCHEMA as any, loading: false, error: null }));
vi.mock('../form/utils/schemaLoader', () => ({
  useSchema: (name: string) => mockUseSchema(name as any),
}));

const LINES = [{ item: 'WIDGET', itemValue: '1', desc: 'A widget', quantity: 2, rate: 10, amount: 20 }];

function renderGrid(isFieldVisible?: IsFieldVisible, props: Record<string, unknown> = {}) {
  const grid = (
    <PickableLineItemsGrid
      lines={LINES}
      config={config}
      schemaName="orderGridLine"
      search={vi.fn(async () => [])}
      onChange={vi.fn()}
      {...props}
    />
  );
  return render(
    isFieldVisible ? <FieldVisibilityProvider value={isFieldVisible}>{grid}</FieldVisibilityProvider> : grid
  );
}

describe('PickableLineItemsGrid columns', () => {
  it('takes every header label from the schema, not from the component', async () => {
    renderGrid();
    for (const label of ['Part', 'What it is', 'How many', 'Unit price', 'Extended']) {
      expect(await screen.findByRole('columnheader', { name: label })).toBeInTheDocument();
    }
    expect(screen.queryByRole('columnheader', { name: 'Amount' })).not.toBeInTheDocument();
  });

  it('falls back to its own labels with no schema', async () => {
    mockUseSchema.mockReturnValueOnce({ schema: null as any, loading: false, error: null });
    renderGrid();
    for (const label of ['Item', 'Description', 'Qty', 'Rate', 'Amount']) {
      expect(await screen.findByRole('columnheader', { name: label })).toBeInTheDocument();
    }
  });

  it('drops the columns the role hides, and the subtotal with the money column', async () => {
    const hide = ['rate', 'amount'];
    renderGrid((permission, field) => permission === 'orderGridLine:read' && !hide.includes(field));
    await waitFor(() => expect(screen.getByRole('columnheader', { name: 'Part' })).toBeInTheDocument());
    expect(screen.queryByRole('columnheader', { name: 'Unit price' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Extended' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Subtotal/)).not.toBeInTheDocument();
    // Remaining columns re-spread to fill the table rather than bunching left.
    const widths = screen.getAllByRole('columnheader').slice(0, 3).map((th) => th.style.width);
    expect(widths).toEqual(weightedWidths(['string', 'textarea', 'number']));
  });

  it('keeps the subtotal while the money column is visible', async () => {
    renderGrid((permission, field) => permission === 'orderGridLine:read' && field !== 'quantity');
    expect(await screen.findByText('Subtotal: 20.00')).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'How many' })).not.toBeInTheDocument();
  });

  it('hides nothing for a grant the role does not hold at all', async () => {
    renderGrid((permission) => permission === 'something:else');
    for (const label of ['Part', 'What it is', 'How many', 'Unit price', 'Extended']) {
      expect(await screen.findByRole('columnheader', { name: label })).toBeInTheDocument();
    }
  });
});

describe('weightedWidths', () => {
  it('normalises to 100% and gives a textarea the most room', () => {
    const widths = weightedWidths(['string', 'textarea', 'number']);
    expect(widths.reduce((sum, w) => sum + parseFloat(w), 0)).toBeCloseTo(100, 1);
    expect(parseFloat(widths[1])).toBeGreaterThan(parseFloat(widths[0]));
    expect(parseFloat(widths[0])).toBeGreaterThan(parseFloat(widths[2]));
  });

  it('falls back to a default weight for an unknown type', () => {
    expect(weightedWidths(['mystery', undefined])).toEqual(['50.00%', '50.00%']);
  });
});
