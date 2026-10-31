import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
// Framework colour defaults; apps override per system in their own index.css.
import './tokens.css';

/**
 * What the user picked. 'system' is a real choice, not the absence of one —
 * it means "keep following the OS", so it has to survive a reload distinctly
 * from someone having explicitly chosen light.
 */
export type ColorModePreference = 'light' | 'dark' | 'system';

/** What the UI actually renders. 'system' is resolved away. */
export type ResolvedColorMode = 'light' | 'dark';

const STORAGE_KEY = 'framework:color-mode';

interface ColorModeContextValue {
  /** The user's stored choice, 'system' included. */
  preference: ColorModePreference;
  /** The mode to render: 'system' resolved against the OS setting. */
  mode: ResolvedColorMode;
  setPreference: (next: ColorModePreference) => void;
  /** light -> dark -> system -> light. */
  cycleMode: () => void;
}

const ColorModeContext = createContext<ColorModeContextValue | null>(null);

const prefersDark = (): boolean => {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    // matchMedia missing (jsdom without a stub, very old browsers) — assume light.
    return false;
  }
};

const readStoredPreference = (): ColorModePreference => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  } catch {
    // Storage blocked (private window, site-data off) — fall through to system.
  }
  return 'system';
};

/**
 * Holds the colour-mode choice and keeps `data-theme` on <html> in sync.
 *
 * CSS keys off `[data-theme="dark"]` rather than `@media (prefers-color-scheme: dark)`
 * so that an in-app toggle actually moves it. A media query would ignore the
 * toggle and follow the OS, leaving MUI dark while plain CSS stayed light.
 */
export const ColorModeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [preference, setPreferenceState] = useState<ColorModePreference>(readStoredPreference);
  const [systemIsDark, setSystemIsDark] = useState<boolean>(prefersDark);

  // Follow the OS while the preference is 'system'. The listener stays
  // attached regardless, so switching back to 'system' is already current.
  useEffect(() => {
    let media: MediaQueryList;
    try {
      media = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }
    const onChange = (e: MediaQueryListEvent) => setSystemIsDark(e.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  const mode: ResolvedColorMode = preference === 'system'
    ? (systemIsDark ? 'dark' : 'light')
    : preference;

  // Stamp the resolved mode where CSS can see it.
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', mode);
    // Keeps form controls, scrollbars and other UA-painted chrome in step.
    root.style.colorScheme = mode;
  }, [mode]);

  const setPreference = useCallback((next: ColorModePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Not persisting is survivable; the choice still applies this session.
    }
  }, []);

  const cycleMode = useCallback(() => {
    setPreference(
      preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light'
    );
  }, [preference, setPreference]);

  const value = useMemo(
    () => ({ preference, mode, setPreference, cycleMode }),
    [preference, mode, setPreference, cycleMode]
  );

  return <ColorModeContext.Provider value={value}>{children}</ColorModeContext.Provider>;
};

/**
 * Read the current colour mode. Safe outside the provider: falls back to a
 * light, inert value so a component (or a test) that renders without the
 * provider does not crash.
 */
export const useColorMode = (): ColorModeContextValue => {
  const ctx = useContext(ColorModeContext);
  if (ctx) return ctx;
  return {
    preference: 'light',
    mode: 'light',
    setPreference: () => {},
    cycleMode: () => {},
  };
};

export default ColorModeProvider;
