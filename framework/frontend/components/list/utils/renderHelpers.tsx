/**
 * List Component Framework - Render Helpers
 * Provides reusable React components for common cell rendering patterns
 * including status badges, two-line cells, date formatting, and badge lists.
 */

import React from 'react';

/**
 * Badge color variants for general use.
 */
export type BadgeVariant = 'primary' | 'secondary' | 'neutral' | 'success' | 'warning' | 'error';

/**
 * One badge in a renderChipList cell.
 */
export interface ChipItem {
  label: string;
  variant?: BadgeVariant;
  /** Tooltip text shown on hover (styled CSS tooltip, see TableCellStyles.css). */
  title?: string;
}

/**
 * Render a status badge with indicator dot.
 * Used for displaying entity status (active, inactive, etc.)
 * 
 * @param status - Status value
 * @param label - Optional custom label (defaults to capitalized status)
 * @returns React element with status indicator
 * 
 * @example
 * renderStatusBadge('active') // Shows "Active" with green dot
 * renderStatusBadge('inactive', 'Not Active') // Shows "Not Active" with gray dot
 */
export const renderStatusBadge = (
  status: string,
  label?: string
): React.ReactElement => {
  const statusValue = status?.toLowerCase() || 'inactive';
  const displayLabel = label || (status ? status.charAt(0).toUpperCase() + status.slice(1) : 'Unknown');
  
  return (
    <span className={`status-indicator status-indicator--${statusValue}`}>
      <span className={`status-dot status-dot--${statusValue}`}></span>
      {displayLabel}
    </span>
  );
};

/**
 * Render a two-line table cell with primary and secondary text.
 * Commonly used for showing a main value with additional context below.
 * 
 * @param primary - Primary text (main content)
 * @param secondary - Secondary text (additional context)
 * @param className - Optional additional CSS class
 * @returns React element with two-line layout
 * 
 * @example
 * renderTwoLineCell('John Doe', 'john@example.com')
 * renderTwoLineCell('Acme Corp', 'Customer')
 */
export const renderTwoLineCell = (
  primary: React.ReactNode,
  secondary: React.ReactNode,
  className?: string
): React.ReactElement => {
  return (
    <div className={`table-cell--two-line ${className || ''}`}>
      <div className="table-cell__primary">{primary}</div>
      <div className="table-cell__secondary">{secondary}</div>
    </div>
  );
};

/**
 * Render a formatted date cell.
 * Handles various date formats and displays in a consistent format.
 * 
 * @param date - Date value (Date object, string, or undefined)
 * @param format - Format style ('short', 'long', 'datetime')
 * @param fallback - Fallback text if date is invalid (default: 'N/A')
 * @returns React element with formatted date
 * 
 * @example
 * renderDateCell(new Date(), 'short') // "01/15/2024"
 * renderDateCell('2024-01-15', 'long') // "January 15, 2024"
 * renderDateCell(undefined, 'short', 'Not set') // "Not set"
 */
export const renderDateCell = (
  date: Date | string | undefined | null,
  format: 'short' | 'long' | 'datetime' = 'short',
  fallback: string = 'N/A'
): React.ReactElement => {
  if (!date) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
  
  try {
    const dateObj = typeof date === 'string' ? new Date(date) : date;
    
    // Check if date is valid
    if (isNaN(dateObj.getTime())) {
      return <span className="table-cell__empty">{fallback}</span>;
    }
    
    let formattedDate: string;
    
    switch (format) {
      case 'long':
        formattedDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
        break;
      case 'datetime':
        formattedDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        break;
      case 'short':
      default:
        formattedDate = dateObj.toLocaleDateString('en-US', {
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        });
        break;
    }
    
    return <span className="table-cell__date">{formattedDate}</span>;
  } catch (error) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
};

/**
 * Render a list of badges (tags, categories, etc.)
 * Shows a limited number of badges with a "+X more" indicator.
 * 
 * @param items - Array of items to display as badges
 * @param maxVisible - Maximum number of badges to show (default: 2)
 * @param variant - Badge color variant (default: 'neutral')
 * @param emptyText - Text to show when array is empty (default: 'None')
 * @returns React element with badge list
 * 
 * @example
 * renderBadgeList(['Tag1', 'Tag2', 'Tag3'], 2) // Shows "Tag1", "Tag2", "+1"
 * renderBadgeList([], 2, 'neutral', 'No tags') // Shows "No tags"
 */
export const renderBadgeList = (
  items: string[] | undefined | null,
  maxVisible: number = 2,
  variant: BadgeVariant = 'neutral',
  emptyText: string = 'None'
): React.ReactElement => {
  if (!items || items.length === 0) {
    return <span className="table-cell__empty">{emptyText}</span>;
  }
  
  const visibleItems = items.slice(0, maxVisible);
  const remainingCount = items.length - maxVisible;
  
  return (
    <div className="table-cell__badge-list">
      {visibleItems.map((item, index) => (
        <span key={index} className={`badge badge--${variant}`}>
          {item}
        </span>
      ))}
      {remainingCount > 0 && (
        <span className="table-cell__badge-more">+{remainingCount}</span>
      )}
    </div>
  );
};

/**
 * Render several independent status badges in one cell — unlike renderBadgeList
 * (a truncated list of same-variant tags), each chip here is its own
 * true/false condition with its own color, and none of them are mutually
 * exclusive (e.g. a row can show both "Shipped" and "No Invoice" at once).
 * Callers compute the chip set from row data; this just lays them out.
 *
 * @example
 * renderChipList([{ label: 'Shipped', variant: 'success' }, { label: 'No Invoice', variant: 'warning' }])
 */
export const renderChipList = (
  chips: ChipItem[],
  emptyText: string = ''
): React.ReactElement => {
  if (!chips.length) {
    return <span className="table-cell__empty">{emptyText}</span>;
  }

  return (
    <div className="table-cell__chip-list">
      {chips.map((chip) => (
        <span
          key={chip.label}
          className={`badge badge--${chip.variant || 'neutral'}`}
          data-tooltip={chip.title || undefined}
        >
          {chip.label}
        </span>
      ))}
    </div>
  );
};

/**
 * Render a simple badge with specified variant.
 * 
 * @param text - Badge text content
 * @param variant - Badge color variant
 * @returns React element with badge
 * 
 * @example
 * renderBadge('Customer', 'primary')
 * renderBadge('Admin', 'warning')
 */
export const renderBadge = (
  text: string,
  variant: BadgeVariant = 'neutral'
): React.ReactElement => {
  return <span className={`badge badge--${variant}`}>{text}</span>;
};

/**
 * Render a phone number as a clickable link.
 * 
 * @param phone - Phone number
 * @param fallback - Fallback text if phone is empty (default: 'N/A')
 * @returns React element with phone link or fallback
 * 
 * @example
 * renderPhoneCell('555-0100') // Clickable tel: link
 * renderPhoneCell(undefined) // Shows "N/A"
 */
export const renderPhoneCell = (
  phone: string | undefined | null,
  fallback: string = 'N/A'
): React.ReactElement => {
  if (!phone) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
  
  return (
    <a href={`tel:${phone}`} className="table-cell__phone-link">
      {phone}
    </a>
  );
};

/**
 * Render an email as a clickable link.
 * 
 * @param email - Email address
 * @param fallback - Fallback text if email is empty (default: 'N/A')
 * @returns React element with email link or fallback
 * 
 * @example
 * renderEmailCell('john@example.com') // Clickable mailto: link
 * renderEmailCell(undefined) // Shows "N/A"
 */
export const renderEmailCell = (
  email: string | undefined | null,
  fallback: string = 'N/A'
): React.ReactElement => {
  if (!email) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
  
  return (
    <a href={`mailto:${email}`} className="table-cell__email-link">
      {email}
    </a>
  );
};

/**
 * Render a location cell with city, state, and optional zip code.
 * 
 * @param city - City name
 * @param state - State name or abbreviation
 * @param zipCode - Optional zip code
 * @param fallback - Fallback text if location is empty (default: 'N/A')
 * @returns React element with location information
 * 
 * @example
 * renderLocationCell('New York', 'NY', '10001')
 * renderLocationCell('Boston', 'MA')
 */
export const renderLocationCell = (
  city: string | undefined | null,
  state: string | undefined | null,
  zipCode?: string | undefined | null,
  fallback: string = 'N/A'
): React.ReactElement => {
  if (!city && !state) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
  
  return (
    <div className="table-cell__location">
      <div>
        {city && state ? `${city}, ${state}` : city || state}
      </div>
      {zipCode && (
        <div className="table-cell__location-zip">{zipCode}</div>
      )}
    </div>
  );
};

/**
 * Render a numeric value with optional formatting.
 * 
 * @param value - Numeric value
 * @param options - Intl.NumberFormat options
 * @param fallback - Fallback text if value is invalid (default: 'N/A')
 * @returns React element with formatted number
 * 
 * @example
 * renderNumberCell(1234.56, { style: 'currency', currency: 'USD' }) // "$1,234.56"
 * renderNumberCell(0.85, { style: 'percent' }) // "85%"
 */
export const renderNumberCell = (
  value: number | undefined | null,
  options?: Intl.NumberFormatOptions,
  fallback: string = 'N/A'
): React.ReactElement => {
  if (value === undefined || value === null || isNaN(value)) {
    return <span className="table-cell__empty">{fallback}</span>;
  }
  
  const formatted = new Intl.NumberFormat('en-US', options).format(value);
  
  return <span className="table-cell__number">{formatted}</span>;
};

/**
 * Render a boolean value as Yes/No or custom labels.
 * 
 * @param value - Boolean value
 * @param trueLabel - Label for true value (default: 'Yes')
 * @param falseLabel - Label for false value (default: 'No')
 * @param variant - Badge variant to use (optional)
 * @returns React element with boolean representation
 * 
 * @example
 * renderBooleanCell(true) // "Yes"
 * renderBooleanCell(false, 'Active', 'Inactive') // "Inactive"
 */
export const renderBooleanCell = (
  value: boolean | undefined | null,
  trueLabel: string = 'Yes',
  falseLabel: string = 'No',
  variant?: BadgeVariant
): React.ReactElement => {
  const label = value ? trueLabel : falseLabel;
  
  if (variant) {
    return renderBadge(label, variant);
  }
  
  return <span>{label}</span>;
};
