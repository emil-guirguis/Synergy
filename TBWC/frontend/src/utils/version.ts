/**
 * Version utility for accessing application version information
 *
 * The version follows Tesla-style format: Year.Week.Build
 * Example: 2025.47.3 (Year 2025, Week 47, Build 3)
 */

interface VersionInfo {
  version: string;
  year: number;
  week: number;
  build: number;
  timestamp: string;
  date: string;
}

let cachedVersion: VersionInfo | null = null;

/**
 * Get the current application version
 * @returns {string} Version string in format YYYY.WW.B
 */
export function getVersion(): string {
  if (cachedVersion) {
    return cachedVersion.version;
  }

  try {
    // In production, version is injected at build time via import.meta.env
    const versionString = import.meta.env.VITE_APP_VERSION;

    if (versionString) {
      return versionString;
    }
  } catch (error) {
    console.warn('Could not load version from environment:', error);
  }

  // Fallback for development
  return 'dev';
}

/**
 * Get full version information
 * @returns {VersionInfo | null} Complete version information or null if not available
 */
export function getVersionInfo(): VersionInfo | null {
  if (cachedVersion) {
    return cachedVersion;
  }

  try {
    const versionData = import.meta.env.VITE_APP_VERSION_INFO;

    if (versionData) {
      cachedVersion = JSON.parse(versionData);
      return cachedVersion;
    }
  } catch (error) {
    console.warn('Could not load version info:', error);
  }

  return null;
}

/**
 * Get a formatted version display string
 * @returns {string} Formatted version for display
 */
export function getVersionDisplay(): string {
  const version = getVersion();
  const info = getVersionInfo();

  if (info) {
    const date = new Date(info.timestamp).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    return `v${version} (${date})`;
  }

  return version === 'dev' ? 'Development' : `v${version}`;
}
