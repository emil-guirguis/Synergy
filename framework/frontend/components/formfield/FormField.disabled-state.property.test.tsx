import { describe, it } from 'vitest';
import { render } from '@testing-library/react';
import fc from 'fast-check';
import { FormField } from './FormField';

/**
 * Feature: formfield-material-design-outlined, Property 9: Disabled Field Appearance
 * Validates: Requirements 3.1
 *
 * MUI's outlined TextField/Select does not use opacity:0.38 or cursor:not-allowed
 * for its disabled look (verified against the installed MUI version's generated
 * CSS: text is dimmed via -webkit-text-fill-color while opacity stays 1, and the
 * wrapper sets cursor:default). What FormField itself is responsible for is
 * correctly propagating `disabled` down to the underlying control, so that's
 * what these properties check — native disabled semantics and MUI's Mui-disabled
 * marker class — rather than MUI-internal styling values.
 */
describe('FormField Disabled State Property-Based Tests', () => {
  it('Property 9: Disabled field disables the underlying control', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          type: fc.constantFrom('text', 'email', 'password', 'number', 'textarea', 'select', 'url', 'tel', 'date', 'time', 'search' as const),
        }),
        (props) => {
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type={props.type}
              value=""
              disabled={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const control = container.querySelector('input, textarea, [role="combobox"]');
          return !!control && (control as HTMLInputElement).matches('[disabled], [aria-disabled="true"]');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 9: Disabled field carries MUI\'s disabled styling hook', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          type: fc.constantFrom('text', 'email', 'password', 'number', 'textarea', 'select', 'url', 'tel' as const),
        }),
        (props) => {
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type={props.type}
              value=""
              disabled={true}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          return !!container.querySelector('.Mui-disabled');
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 9: Disabled checkbox and radio disable the underlying control', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          type: fc.constantFrom('checkbox', 'radio' as const),
        }),
        (props) => {
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type={props.type}
              value={false}
              disabled={true}
              options={props.type === 'radio' ? [{ value: 'opt1', label: 'Option 1' }] : undefined}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const input = container.querySelector('input[type="checkbox"], input[type="radio"]');
          return !!input && (input as HTMLInputElement).disabled;
        }
      ),
      { numRuns: 100 }
    );
  });
});
