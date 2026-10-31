/**
 * Vite plugin to inject version information at build time
 */

import fs from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

export function versionPlugin(): Plugin {
  return {
    name: 'version-plugin',
    config() {
      // Read version file
      const versionFilePath = path.resolve(process.cwd(), '../../version.json');
      let versionData = {
        version: 'dev',
        year: new Date().getFullYear(),
        week: 1,
        build: 0,
        timestamp: new Date().toISOString(),
        date: 'Development'
      };

      if (fs.existsSync(versionFilePath)) {
        try {
          versionData = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
        } catch (error) {
          console.warn('⚠️  Could not read version file, using development version');
        }
      } else {
      }

      // Inject version into environment variables
      return {
        define: {
          'import.meta.env.VITE_APP_VERSION': JSON.stringify(versionData.version),
          'import.meta.env.VITE_APP_VERSION_INFO': JSON.stringify(JSON.stringify(versionData)),
        },
      };
    },
  };
}
