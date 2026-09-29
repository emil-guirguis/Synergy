import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import fc from 'fast-check';
import { FormField } from './FormField';

/**
 * Feature: formfield-material-design-outlined, Property 5: Input Type Styling Consistency
 * Validates: Requirements 2.1
 */
describe('FormField Input Type Styling Property-Based Tests', () => {
  it('Property 5: All text input types have outlined border', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('text', 'email', 'password', 'number', 'url', 'tel' as const),
        (type) => {
          const { container } = render(
            <FormField
              name="test"
              label="Test"
              type={type}
              value=""
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          // MUI's outlined variant draws the border on the sibling <fieldset>
          // (the notched-outline), not on the <input> itself.
          const fieldset = container.querySelector('fieldset');
          const styles = window.getComputedStyle(fieldset!);
          return styles.borderStyle === 'solid' && styles.borderWidth === '1px';
        }
      ),
      { numRuns: 100 }
    );
  });

  it('Property 5: All text input types have consistent padding', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('text', 'email', 'password', 'number', 'url', 'tel' as const),
        (type) => {
          const { container } = render(
            <FormField
              name="test"
              label="Test"
              type={type}
              value=""
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const input = container.querySelector('input');
          const styles = window.getComputedStyle(input!);
          return styles.paddingTop !== '' && styles.paddingLeft !== '';
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: formfield-material-design-outlined, Property 6: Textarea Material Design Styling
   * Validates: Requirements 2.2
   */
  it('Property 6: Textarea has Material Design outlined styling', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          value: fc.string({ maxLength: 500 }),
          rows: fc.integer({ min: 2, max: 10 }),
        }),
        (props) => {
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type="textarea"
              value={props.value}
              rows={props.rows}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          const fieldset = container.querySelector('fieldset');
          const styles = window.getComputedStyle(fieldset!);
          return styles.borderStyle === 'solid' && styles.borderWidth === '1px';
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: formfield-material-design-outlined, Property 7: Select Field Styling
   * Validates: Requirements 2.3
   */
  it('Property 7: Select field has Material Design outlined styling', () => {
    fc.assert(
      fc.property(
        fc.record({
          name: fc.string({ minLength: 1, maxLength: 50 }),
          label: fc.string({ minLength: 1, maxLength: 50 }),
          value: fc.oneof(fc.string({ maxLength: 50 }), fc.constant('')),
        }),
        (props) => {
          const { container } = render(
            <FormField
              name={props.name}
              label={props.label}
              type="select"
              value={props.value}
              options={[{ value: 'opt1', label: 'Option 1' }]}
              onChange={() => {}}
              onBlur={() => {}}
            />
          );
          // MUI's Select renders a div[role="combobox"], not a native <select>;
          // its outlined border, like the other variants, is on the fieldset.
          const fieldset = container.querySelector('fieldset');
          const styles = window.getComputedStyle(fieldset!);
          return styles.borderStyle === 'solid' && styles.borderWidth === '1px';
        }
      ),
      { numRuns: 100 }
    );
  });
});
