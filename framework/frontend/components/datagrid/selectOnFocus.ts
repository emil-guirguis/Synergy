import type React from 'react';

/**
 * onFocus for numeric grid cells: select the whole value so typing replaces it
 * (spreadsheet behaviour). Deferred one tick — selecting synchronously gets
 * undone by the click's own mouseup, which collapses the selection to a caret.
 */
export const selectOnFocus = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
  const el = e.target;
  setTimeout(() => {
    if (document.activeElement === el) el.select();
  }, 0);
};
