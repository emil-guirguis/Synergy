/**
 * System Config store
 *
 * The org-wide display settings from Settings > System Config (timezone,
 * dateFormat, timeFormat, currency) ride along on the authenticated user
 * object (TBWC's /auth/me, MeterItPro's /auth/verify|login|refresh) — each
 * app's AuthContext calls setSystemConfig() whenever that user object
 * changes. Formatting helpers (dateHelpers, numberHelpers) and non-React
 * code (schemaColumnGenerator) read the current value via getSystemConfig();
 * components that need to re-render on change use useSystemConfig().
 *
 * Module-level singleton, not React Context: column `render` functions are
 * plain closures created outside any component tree (schemaColumnGenerator,
 * list page column overrides), so they need a plain synchronous getter, not
 * a hook.
 */
import { useSyncExternalStore } from 'react';

export interface SystemConfigFields {
  timezone?: string | null;
  /** Free-text pattern using YYYY/YY/MM/M/DD/D tokens, e.g. "MM/DD/YYYY". */
  date_format?: string | null;
  time_format?: '12h' | '24h' | null;
  /** ISO 4217 code, e.g. "USD". */
  currency?: string | null;
  default_page_size?: number | null;
}

let current: SystemConfigFields = {};
const listeners = new Set<() => void>();

/** Called by each app's AuthContext whenever the authenticated user (profile/tenant) changes. */
export function setSystemConfig(fields: SystemConfigFields): void {
  current = { ...current, ...fields };
  listeners.forEach((listener) => listener());
}

export function getSystemConfig(): SystemConfigFields {
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook variant — re-renders the component when system config changes. */
export function useSystemConfig(): SystemConfigFields {
  return useSyncExternalStore(subscribe, getSystemConfig);
}
