import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Unsaved-changes tracking for a form modal. Anything inside the form that
 * holds edits outside BaseForm's own formData (e.g. PickableLineItemsGrid's
 * pending lines) reports under its own `source` key; the modal is dirty while
 * any source is. Outside a provider, reporting is a no-op.
 */
interface FormDirtyContextValue {
  reportDirty: (source: string, dirty: boolean) => void;
}

export const FormDirtyContext = createContext<FormDirtyContextValue>({ reportDirty: () => {} });

/** Owner side: wrap the form in <FormDirtyContext.Provider value={contextValue}>, read `isDirty`, `reset()` when a fresh form opens. */
export function useFormDirtyTracker() {
  const [sources, setSources] = useState<Set<string>>(() => new Set());

  const reportDirty = useCallback((source: string, dirty: boolean) => {
    setSources(prev => {
      if (prev.has(source) === dirty) return prev;
      const next = new Set(prev);
      if (dirty) next.add(source); else next.delete(source);
      return next;
    });
  }, []);

  const reset = useCallback(() => setSources(new Set()), []);
  const contextValue = useMemo(() => ({ reportDirty }), [reportDirty]);

  return { isDirty: sources.size > 0, reset, contextValue };
}

/** Reporter side: keeps `source` marked dirty while `dirty` is true; clears on unmount. */
export function useReportDirty(source: string, dirty: boolean) {
  const { reportDirty } = useContext(FormDirtyContext);
  useEffect(() => {
    reportDirty(source, dirty);
  }, [reportDirty, source, dirty]);
  useEffect(() => () => reportDirty(source, false), [reportDirty, source]);
}
