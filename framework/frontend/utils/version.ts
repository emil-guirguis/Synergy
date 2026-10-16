/**
 * Framework version utility
 * 
 * This provides a default implementation that can be overridden by client applications.
 * The version follows Tesla-style format: Year.Week.Build
 */

/**
 * Get the application version
 * This is a default implementation that should be overridden by the client app
 * @returns {string} Version string
 */
export function getAppVersion(): string {
  // Try to get version from environment (injected at build time)
  if (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_APP_VERSION) {
    return (import.meta as any).env.VITE_APP_VERSION;
  }
  
  // Fallback for development
  return 'dev';
}

/**
 * Format version for display
 * @param {string} version - Version string
 * @returns {string} Formatted version
 */
export function formatVersion(version: string): string {
  if (version === 'dev') {
    return 'Development';
  }
  return `v${version}`;
}

/** The whole version.json payload, as scripts/generate-version.mjs writes it. */
export interface VersionInfo {
  version: string;
  year: number;
  week: number;
  build: number;
  timestamp: string;
  date: string;
}

let cachedInfo: VersionInfo | null = null;

/**
 * Full build info, injected by each app's vite-plugins/version-plugin.ts as a
 * JSON string. Null in dev, or whenever the plugin didn't run.
 */
export function getVersionInfo(): VersionInfo | null {
  if (cachedInfo) return cachedInfo;
  try {
    const raw = typeof import.meta !== 'undefined' ? (import.meta as any).env?.VITE_APP_VERSION_INFO : null;
    if (raw) {
      cachedInfo = JSON.parse(raw) as VersionInfo;
      return cachedInfo;
    }
  } catch {
    // A malformed payload is not worth breaking a page over — fall through to the
    // version string on its own.
  }
  return null;
}

/**
 * What to print in a footer: "v2026.42.21 (October 16, 2026)", or just the version
 * when the build date isn't available. Lived in duplicate copies of
 * {TBWC,MeterItPro}/frontend/src/utils/version.ts until the login page started
 * rendering it from the framework (both apps' version-plugin.ts define the same
 * two env vars, so one implementation covers both).
 */
export function getVersionDisplay(): string {
  const version = getAppVersion();
  const info = getVersionInfo();
  if (info) {
    const date = new Date(info.timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `v${version} (${date})`;
  }
  return formatVersion(version);
}
