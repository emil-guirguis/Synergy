import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Force these to resolve from the client's own node_modules, matching boundary at "/"
    // so deep subpath imports (e.g. "@mui/icons-material/Visibility") are covered too — not
    // just bare specifiers. Without this, a subpath import used from within framework/frontend
    // pulls in its own separately-installed copy, producing a second React/MUI instance in the
    // same test and "Cannot read properties of null (reading 'useContext')" crashes.
    alias: [
      { find: '@framework', replacement: path.resolve(__dirname, '../../framework/frontend') },
      { find: /^react(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/react') + '$1' },
      { find: /^react-dom(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/react-dom') + '$1' },
      { find: /^@mui\/material(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/@mui/material') + '$1' },
      { find: /^@mui\/icons-material(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/@mui/icons-material') + '$1' },
      { find: /^@emotion\/react(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/@emotion/react') + '$1' },
      { find: /^@emotion\/styled(\/.*)?$/, replacement: path.resolve(__dirname, 'node_modules/@emotion/styled') + '$1' },
    ],
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    server: {
      deps: {
        inline: [/@mui\//, /@emotion\//],
      },
    },
    css: true,
    reporters: ['verbose'],
    coverage: {
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/'],
    },
  },
});
