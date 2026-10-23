/**
 * The read-only QB lines grid takes its columns from the child-row schema it's
 * pointed at (orderGridLine / invoiceGridLine) and from that grant's column
 * visibility — it used to carry two hardcoded column lists instead, which is
 * why unticking Rate in Settings > Roles left a blank column behind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrderLinesGrid } from './OrderLinesGrid';

const SCHEMAS: Record<string, any> = {
  orderGridLine: {
    formFields: {
      item: { type: 'string', label: 'Item', showOn: ['list'] },
      desc: { type: 'textarea', label: 'Description', showOn: ['list'] },
      quantity: { type: 'number', label: 'Qty', showOn: ['list'] },
      rate: { type: 'currency', label: 'Rate', showOn: ['list'] },
      amount: { type: 'currency', label: 'Amount', showOn: ['list'] },
      internal: { type: 'string', label: 'Internal', showOn: ['form'] },
    },
  },
};

vi.mock('@meterit/framework-frontend/components/form/utils/schemaLoader', () => ({
  useSchema: (name: string) => ({ schema: SCHEMAS[name] ?? null, loading: false, error: null }),
}));

/** Fields the role hides on orderGridLine:read. */
let hidden: string[] = [];
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    isFieldVisible: (permission: string, field: string) =>
      permission === 'orderGridLine:read' && !hidden.includes(field),
  }),
}));

const LINES = [
  { item: 'WIDGET', desc: 'A widget', quantity: 2, rate: 10, amount: 20 },
  { item: 'BRACKET', desc: 'A bracket', quantity: 1, rate: 5, amount: 5 },
];

const headers = () => screen.getAllByRole('columnheader').map((th) => th.textContent);

beforeEach(() => {
  hidden = [];
});

describe('OrderLinesGrid', () => {
  it('builds its columns from the schema, list fields only', () => {
    render(<OrderLinesGrid lines={LINES} schemaName="orderGridLine" total={25} freight={3} />);
    expect(headers()).toEqual(['Item', 'Description', 'Qty', 'Rate', 'Amount']);
    expect(screen.queryByRole('columnheader', { name: 'Internal' })).not.toBeInTheDocument();
  });

  it('formats currency fields and leaves the rest alone', () => {
    render(<OrderLinesGrid lines={LINES} schemaName="orderGridLine" total={25} />);
    expect(screen.getByText('$10.00')).toBeInTheDocument();
    expect(screen.getByText('A widget')).toBeInTheDocument();
  });

  it('totals Subtotal/Freight/Total, freight added on top of the order total', () => {
    render(<OrderLinesGrid lines={LINES} schemaName="orderGridLine" total={25} freight={3} />);
    expect(screen.getByText('Subtotal')).toBeInTheDocument();
    expect(screen.getByText('$25.00')).toBeInTheDocument(); // 2 lines = 25
    expect(screen.getByText('$3.00')).toBeInTheDocument(); // freight
    expect(screen.getByText('$28.00')).toBeInTheDocument(); // grand total
  });

  it('drops a hidden money column and the footer that totals it', () => {
    hidden = ['rate', 'amount'];
    render(<OrderLinesGrid lines={LINES} schemaName="orderGridLine" total={25} freight={3} />);
    expect(headers()).toEqual(['Item', 'Description', 'Qty']);
    expect(screen.queryByText('Subtotal')).not.toBeInTheDocument();
    expect(screen.queryByText('$28.00')).not.toBeInTheDocument();
  });

  it('keeps the footer while Amount is visible, even without Rate', () => {
    hidden = ['rate'];
    render(<OrderLinesGrid lines={LINES} schemaName="orderGridLine" total={25} freight={3} />);
    expect(headers()).toEqual(['Item', 'Description', 'Qty', 'Amount']);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$28.00')).toBeInTheDocument();
  });

  it('renders nothing at all until the schema that defines the columns is there', () => {
    const { container } = render(<OrderLinesGrid lines={LINES} schemaName="nopeGridLine" />);
    expect(container).toBeEmptyDOMElement();
  });
});
