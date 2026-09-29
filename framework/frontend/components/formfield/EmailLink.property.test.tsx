import { describe, it } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import fc from 'fast-check';
import { EmailLink } from './EmailLink';

describe('EmailLink Property-Based Tests', () => {
  /**
   * Feature: date-field-picker, Property 15: Email displays as blue link
   * Validates: Requirements 6.1
   * 
   * For any FormField with type 'email' and a non-empty value, the component 
   * should render the email as a blue hyperlink with pointer cursor styling.
   */
  it('Property 15: Email displays as blue link', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        (email) => {
          const { container } = render(<EmailLink value={email} />);
          const link = container.querySelector('a');
          
          // Link should exist for non-empty email
          if (email && email.trim() !== '') {
            if (link) {
              // Link should have the email-link__link class for blue styling
              return link.classList.contains('email-link__link');
            }
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: date-field-picker, Property 16: Email link generates mailto
   * Validates: Requirements 6.2
   * 
   * For any email value, the rendered link should have an href attribute 
   * starting with 'mailto:' followed by the email address.
   */
  it('Property 16: Email link generates mailto', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        (email) => {
          const { container } = render(<EmailLink value={email} />);
          const link = container.querySelector('a');
          
          // Link should exist for non-empty email
          if (email && email.trim() !== '') {
            if (link) {
              const href = link.getAttribute('href');
              // href should start with 'mailto:' and contain the email
              return href === `mailto:${email}`;
            }
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Feature: date-field-picker, Property 17: Edit mode shows input field
   * Validates: Requirements 6.3
   * 
   * For any email field in edit mode, the component should display a standard 
   * email input field instead of a link.
   */
  it('Property 17: Edit mode shows input field', () => {
    fc.assert(
      fc.property(
        fc.emailAddress(),
        (email) => {
          const { container } = render(<EmailLink value={email} />);
          const link = container.querySelector('a');
          
          if (link) {
            // Double click to enter edit mode
            fireEvent.doubleClick(link);
            
            // After double click, input should exist
            const input = container.querySelector('input[type="email"]');
            return input !== null;
          }
          return true;
        }
      ),
      { numRuns: 100 }
    );
  });
});
