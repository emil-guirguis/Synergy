import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import { defineConfig, globalIgnores } from 'eslint/config';

// Mirrors MeterItPro/frontend/eslint.config.js. Every plugin below was already
// declared in this package's devDependencies, but there was no config file at
// all, so `npm run lint` ("eslint .") had nothing to read and could not pass.
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
      prettier,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Browser console noise was swept out 2026-10-30; this keeps it out.
      // warn/error stay allowed — they report problems rather than trace flow.
      // Need diagnostics? Put them behind an explicit flag (see LOG_SQL in
      // api/worker/db.ts) or a named debug helper, not a bare console.log.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
]);
