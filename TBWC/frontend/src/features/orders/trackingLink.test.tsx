import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { parseAllTracking, renderTrackingText } from './trackingLink';

describe('parseAllTracking', () => {
  it('returns empty array for null/undefined/empty text', () => {
    expect(parseAllTracking(null)).toEqual([]);
    expect(parseAllTracking(undefined)).toEqual([]);
    expect(parseAllTracking('')).toEqual([]);
  });

  it('matches a UPS number on its own, no carrier name needed', () => {
    const result = parseAllTracking('1Z999AA10123456784');
    expect(result).toEqual([
      {
        carrier: 'UPS',
        number: '1Z999AA10123456784',
        url: 'https://www.ups.com/track?tracknum=1Z999AA10123456784',
      },
    ]);
  });

  it('does not match a bare 12-digit number without "fedex" in the text', () => {
    expect(parseAllTracking('Tracking: 123456789012')).toEqual([]);
  });

  it('matches a 12-digit FedEx number only when "fedex" is present', () => {
    const result = parseAllTracking('Shipped via FedEx: 123456789012');
    expect(result).toEqual([
      {
        carrier: 'FedEx',
        number: '123456789012',
        url: 'https://www.fedex.com/fedextrack/?trknbr=123456789012',
      },
    ]);
  });

  it('does not match a bare 9-digit number without "xpo" in the text', () => {
    expect(parseAllTracking('PRO: 706060751')).toEqual([]);
  });

  it('matches an XPO PRO number (dashed) only when "xpo" is present', () => {
    const result = parseAllTracking('XPO PRO 706-060751');
    expect(result).toEqual([
      {
        carrier: 'XPO',
        number: '706-060751',
        url: 'https://ext-web.ltl-xpo.com/public-app/shipments?referenceNumber=706-060751',
      },
    ]);
  });

  it('dedupes a number that would otherwise match more than once', () => {
    const result = parseAllTracking('XPO 706060751 706060751');
    expect(result).toHaveLength(1);
  });

  it('finds multiple distinct numbers across carriers in one blob', () => {
    const result = parseAllTracking('1Z999AA10123456784 and FedEx 123456789012, also XPO 706-060751');
    expect(result.map((t) => t.carrier).sort()).toEqual(['FedEx', 'UPS', 'XPO']);
  });
});

describe('renderTrackingText', () => {
  it('returns the raw text untouched when there is nothing to link', () => {
    expect(renderTrackingText('no tracking here', [])).toBe('no tracking here');
  });

  it('renders a recognized number as a link to the right carrier URL', () => {
    const tracking = parseAllTracking('1Z999AA10123456784');
    render(<>{renderTrackingText('Tracking: 1Z999AA10123456784', tracking)}</>);
    const link = screen.getByRole('link', { name: '1Z999AA10123456784' });
    expect(link).toHaveAttribute('href', 'https://www.ups.com/track?tracknum=1Z999AA10123456784');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('leaves surrounding text unlinked, only wrapping the number', () => {
    const tracking = parseAllTracking('1Z999AA10123456784');
    render(<>{renderTrackingText('Tracking: 1Z999AA10123456784 (2nd pkg)', tracking)}</>);
    expect(screen.getByText(/Tracking:/)).toBeInTheDocument();
    expect(screen.getByText(/2nd pkg/)).toBeInTheDocument();
    expect(screen.getByRole('link')).toBeInTheDocument();
  });
});
