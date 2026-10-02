import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EditableDataGrid, type GridColumn } from './EditableDataGrid';

// Mirrors the real-world pattern (TenantEquipmentGrid, TBWC's ManagedUsersGrid):
// a select column whose options() returns null/[] for every row except the
// one in-progress unsaved row, "so the floating select never opens" for an
// already-saved row.
const columns: GridColumn[] = [
  {
    key: 'pick',
    label: 'Pick',
    editable: true,
    type: 'select',
    options: (rowId: number) => (rowId === 0 ? ['a', 'b'] : (null as unknown as string[])),
  },
];

describe('EditableDataGrid — select column with no options for a given row', () => {
  it('clicking an already-saved row\'s select cell does not crash and does not open a picker', async () => {
    const user = userEvent.setup();
    const data = [{ id: 1, pick: 'a' }, { id: 2, pick: 'b' }];
    render(<EditableDataGrid data={data} columns={columns} />);

    const savedCell = screen.getByText('b');
    await user.click(savedCell);

    // No MUI Select (listbox trigger) mounted for this row — the click was a no-op.
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('clicking the unsaved row (options present) still opens the picker', async () => {
    const user = userEvent.setup();
    const data = [{ id: 0, pick: '', _isUnsaved: true }];
    render(<EditableDataGrid data={data} columns={columns} onCellChange={vi.fn()} />);

    const cell = document.querySelector('[data-row-id="0"][data-column="pick"]') as HTMLElement;
    await user.click(cell);

    expect(screen.getByRole('combobox')).toBeInTheDocument();
  });
});
