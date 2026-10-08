import { useCallback, useState } from 'react';

export interface ShareTarget {
  url: string;
  title: string;
}

/** Tiny bit of state shared by every ShareMenu call site (a list row's Share
 *  icon, a form's Share button) — open/close plus which record is targeted. */
export function useShareTarget() {
  const [shareTarget, setShareTarget] = useState<ShareTarget | null>(null);
  const openShare = useCallback((target: ShareTarget) => setShareTarget(target), []);
  const closeShare = useCallback(() => setShareTarget(null), []);
  return { shareTarget, openShare, closeShare };
}
