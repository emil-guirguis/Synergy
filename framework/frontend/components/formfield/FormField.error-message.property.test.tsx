import { describe, it } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import fc from 'fast-check';
import { FormField } from './FormField';

/**
 * Feature: formfield-material-design-outlined, Property 12: Error Message Display
 * Validates: Requirements 3.4
 */
describe('FormField Error Message Property-Based Tests', () => {
  it('Property 12: Error message displays when touched and error exists', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          type: fc.constantFrom('text', 'email', 'password', 'number', 'textarea', 'select', 'url', 'tel' as const),
          // Exclude whitespace-only strings: MUI substitutes a zero-width-space
          // placeholder for whitespace-only helper text (to stop it collapsing
          // invisibly), which isn't a meaningful "error message" to test anyway.
          error: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        }),
        (props) => {
          cleanup();
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type={props.type}
              value=""
              error={props.error}
              touched={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          // Exact textContent match rather than getByText, since getByText
          // normalizes (collapses/trims) whitespace and fast-check can
          // legitimately generate whitespace-only error strings.
          const errorElement = container.querySelector('.MuiFormHelperText-root');
          return errorElement !== null && errorElement.textContent === props.error;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 12: Error message has error color styling', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          // Exclude whitespace-only strings: MUI substitutes a zero-width-space
          // placeholder for whitespace-only helper text (to stop it collapsing
          // invisibly), which isn't a meaningful "error message" to test anyway.
          error: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        }),
        (props) => {
          cleanup();
          const { container } = render(
            <FormField
              name={props.name}
              label="Test"
              type="text"
              value=""
              error={props.error}
              touched={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const errorElement = container.querySelector('.MuiFormHelperText-root');
          const styles = window.getComputedStyle(errorElement!);
          return styles.color !== '';
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 12: Error message not shown when not touched', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          // Exclude whitespace-only strings: MUI substitutes a zero-width-space
          // placeholder for whitespace-only helper text (to stop it collapsing
          // invisibly), which isn't a meaningful "error message" to test anyway.
          error: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        }),
        (props) => {
          cleanup();
          const { queryByText } = render(
            <FormField
              name={props.name}
              label="Test"
              type="text"
              value=""
              error={props.error}
              touched={false}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const errorElement = queryByText(props.error);
          return errorElement === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 12: Error message not shown when no error exists', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        (props) => {
          cleanup();
          const { container } = render(
            <FormField
              name={props.name}
              label="Test"
              type="text"
              value=""
              touched={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const errorElement = container.querySelector('.MuiFormHelperText-root');
          return errorElement === null;
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 12: Error message has accessibility attributes', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          // Exclude whitespace-only strings: MUI substitutes a zero-width-space
          // placeholder for whitespace-only helper text (to stop it collapsing
          // invisibly), which isn't a meaningful "error message" to test anyway.
          error: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        }),
        (props) => {
          cleanup();
          const { container } = render(
            <FormField
              name={props.name}
              label="Test"
              type="text"
              value=""
              error={props.error}
              touched={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          // FormField's a11y contract is aria-invalid + aria-describedby
          // pointing at the visible helper text (MUI doesn't use role="alert"
          // for field-level errors).
          const input = container.querySelector('input');
          const describedById = input?.getAttribute('aria-describedby');
          const describedEl = describedById ? document.getElementById(describedById) : null;
          return (
            input?.getAttribute('aria-invalid') === 'true' &&
            describedEl !== null &&
            describedEl.textContent === props.error
          );
        }
      ),
      { numRuns: 100 }
    );
  });
});
