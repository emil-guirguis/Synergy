import React from 'react';
import './EmptyState.css';

interface EmptyStateProps {
  /** The headline. Keep it a statement of fact, not an apology. */
  message?: string;
  /** Optional second line: why it's empty, or what to do about it. */
  hint?: string;
  /** Optional glyph or icon element shown above the message. */
  icon?: React.ReactNode;
  /** Optional call to action — a button, link, or anything clickable. */
  action?: React.ReactNode;
  /** Tighter spacing, for empty states inside a card or a narrow panel. */
  compact?: boolean;
}

/**
 * The shared empty state. Use it wherever a list, table, or panel has
 * nothing to show, so "no rows" reads the same everywhere instead of
 * each surface inventing its own bare sentence.
 */
export const EmptyState: React.FC<EmptyStateProps> = ({
  message = 'No data available',
  hint,
  icon,
  action,
  compact = false,
}) => {
  return (
    <div
      className={`empty-state ${compact ? 'empty-state--compact' : ''}`}
      role="status"
      aria-live="polite"
    >
      {icon && (
        <div className="empty-state__icon" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="empty-state__message">{message}</p>
      {hint && <p className="empty-state__hint">{hint}</p>}
      {action && <div className="empty-state__action">{action}</div>}
    </div>
  );
};

export default EmptyState;
