import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BaseList } from './BaseList';
import type { ColumnDefinition } from './types/ui';

type Row = { id: number; name: string };

const columns: ColumnDefinition<Row>[] = [{ key: 'name', label: 'Name' }];
const data: Row[] = [{ id: 1, name: 'Row one' }];

function renderList(props: Partial<React.ComponentProps<typeof BaseList<Row>>> = {}) {
  return render(
    <BaseList<Row>
      title="Orders"
      data={data}
      columns={columns}
      filters={<div data-testid="filter-panel">filters</div>}
      {...props}
    />
  );
}

const filterButton = () => screen.getByRole('button', { name: /filter/i });
const panel = () => screen.queryByTestId('filter-panel');

describe('BaseList — filter panel expand/collapse memory', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('starts collapsed when nothing is remembered and no default is given', () => {
    renderList();
    expect(panel()).not.toBeInTheDocument();
  });

  it('honours defaultFiltersOpen on a first visit', () => {
    renderList({ defaultFiltersOpen: true });
    expect(panel()).toBeInTheDocument();
  });

  it('remembers an expand across remounts, overriding the collapsed default', async () => {
    const user = userEvent.setup();
    const { unmount } = renderList();

    await user.click(filterButton());
    expect(panel()).toBeInTheDocument();
    expect(window.localStorage.getItem('fw:list-filters-open:orders')).toBe('1');

    unmount();
    renderList();
    expect(panel()).toBeInTheDocument();
  });

  it('remembers a collapse across remounts, overriding defaultFiltersOpen', async () => {
    const user = userEvent.setup();
    const { unmount } = renderList({ defaultFiltersOpen: true });

    await user.click(filterButton());
    expect(panel()).not.toBeInTheDocument();
    expect(window.localStorage.getItem('fw:list-filters-open:orders')).toBe('0');

    unmount();
    renderList({ defaultFiltersOpen: true });
    expect(panel()).not.toBeInTheDocument();
  });

  it('keeps each list separate — one list title does not move another', async () => {
    const user = userEvent.setup();
    const { unmount } = renderList();
    await user.click(filterButton());
    unmount();

    renderList({ title: 'Invoices' });
    expect(panel()).not.toBeInTheDocument();
  });

  it('uses filtersStorageKey over the title when both are present', async () => {
    const user = userEvent.setup();
    renderList({ filtersStorageKey: 'orders-widget' });

    await user.click(filterButton());
    expect(window.localStorage.getItem('fw:list-filters-open:orders-widget')).toBe('1');
    expect(window.localStorage.getItem('fw:list-filters-open:orders')).toBeNull();
  });

  it('still toggles when storage is unavailable', async () => {
    const user = userEvent.setup();
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    Storage.prototype.getItem = () => {
      throw new Error('storage blocked');
    };
    Storage.prototype.setItem = () => {
      throw new Error('storage blocked');
    };

    try {
      renderList();
      expect(panel()).not.toBeInTheDocument();
      await user.click(filterButton());
      expect(panel()).toBeInTheDocument();
    } finally {
      Storage.prototype.getItem = getItem;
      Storage.prototype.setItem = setItem;
    }
  });
});
