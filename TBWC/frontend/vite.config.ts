import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { versionPlugin } from './vite-plugins/version-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// TBWC/frontend sits two levels under the repo root — same depth as
// MeterItPro/frontend — so the framework path matches MeterItPro exactly.
export default defineConfig({
  plugins: [react(), versionPlugin()],
  resolve: {
    alias: {
      '@framework': path.resolve(__dirname, '../../framework/frontend'),
    },
    // Prevent duplicate copies of common libs (avoid bundling framework's node_modules separately)
    dedupe: [
      'react',
      'react-dom',
      'react-router-dom',
      'scheduler',
      '@emotion/react',
      '@emotion/styled',
      '@mui/material',
      '@mui/icons-material',
      '@mui/system',
      'zustand',
    ],
  },
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      '@mui/material',
      '@mui/icons-material',
      '@emotion/react',
      '@emotion/styled',
      'react-router-dom',
      'zustand',
    ],
  },
  server: {
    host: '0.0.0.0',
    port: 5174,
    strictPort: true, // Fail loudly if 5174 is taken instead of silently coexisting
    fs: {
      allow: ['.', '../../framework/frontend', '../../node_modules'],
    },
  },
  clearScreen: false,
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/react/') ||
            id.includes('node_modules/react-dom/') ||
            id.includes('node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/@mui/') || id.includes('node_modules/@emotion/')) {
            return 'vendor-mui';
          }
          if (id.includes('node_modules/react-router') || id.includes('node_modules/@remix-run/')) {
            return 'vendor-router';
          }
          if (id.includes('node_modules/')) {
            return 'vendor-misc';
          }
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  base: process.env.VITE_BASE_PATH ?? '/',
});
