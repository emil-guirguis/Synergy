import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { FormField } from './FormField';

/**
 * A native date input clears one segment per keypress (month, then day, then
 * year), so emptying a date took three deletes — and a half-cleared input
 * already reports '' while still looking filled in. These cover the single
 * gesture that empties the whole field.
 */
describe('FormField date clearing', () => {
  afterEach(cleanup);

  it('shows a clear button for an optional date that has a value', () => {
    render(
      <FormField name="ship_date" label="Ship Date" type="date" value="2026-10-29" onChange={() => {}} />
    );
    expect(screen.getByTestId('clear-ship_date')).toBeTruthy();
  });

  it('offers no clear button when the field is empty, required, or disabled', () => {
    const { rerender } = render(
      <FormField name="ship_date" label="Ship Date" type="date" value="" onChange={() => {}} />
    );
    expect(screen.queryByTestId('clear-ship_date')).toBeNull();

    rerender(
      <FormField name="ship_date" label="Ship Date" type="date" value="2026-10-29" required onChange={() => {}} />
    );
    expect(screen.queryByTestId('clear-ship_date')).toBeNull();

    rerender(
      <FormField name="ship_date" label="Ship Date" type="date" value="2026-10-29" disabled onChange={() => {}} />
    );
    expect(screen.queryByTestId('clear-ship_date')).toBeNull();
  });

  it('clicking clear reports the whole field empty in one change', () => {
    const onChange = vi.fn();
    render(
      <FormField name="ship_date" label="Ship Date" type="date" value="2026-10-29" onChange={onChange} />
    );
    fireEvent.click(screen.getByTestId('clear-ship_date'));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0].target).toMatchObject({ name: 'ship_date', value: '' });
  });

  it('Delete and Backspace clear the whole value, not one segment', () => {
    const onChange = vi.fn();
    render(
      <FormField name="ship_date" label="Ship Date" type="date" value="2026-10-29" onChange={onChange} />
    );
    const input = document.querySelector('input[name="ship_date"]')!;
    fireEvent.keyDown(input, { key: 'Delete' });
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange.mock.calls.every((c) => c[0].target.value === '')).toBe(true);
  });
});
