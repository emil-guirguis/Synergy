import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { versionPlugin } from './vite-plugins/version-plugin';
import { docsPlugin } from './vite-plugins/docs-plugin';
import { spaFallbackPlugin } from './vite-plugins/spa-fallback-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom plugin to log errors to terminal
const errorLoggerPlugin = () => {
  return {
    name: 'error-logger',
    configureServer(server: any) {
      server.ws.on('connection', () => {
        server.ws.on('error', (error: any) => {
          console.error('\n❌ WebSocket Error:', error);
        });
      });

      // Log HMR errors
      server.middlewares.use((err: any, _req: any, _res: any, next: any) => {
        if (err) {
          console.error('\n❌ Server Error:', err.message);
          console.error(err.stack);
        }
        next(err);
      });
    },
    transform(_code: any) {
      // This will catch transform errors
      return null;
    },
    handleHotUpdate({ file }: any) {
    },
  };
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    versionPlugin(),
    docsPlugin(),
    react({
      // Log React errors to terminal
      babel: {
        parserOpts: {
          plugins: ['decorators-legacy'],
        },
      },
    }),
    errorLoggerPlugin(),
    spaFallbackPlugin(),
  ],
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
      'recharts',
      'zustand',
      'axios',
      'react-grid-layout',
      'react-resizable',
      'apexcharts',
      'react-apexcharts',
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
      'react-grid-layout',
      'recharts',
      'react-router-dom',
      'immer',
      'zustand',
      'axios'
    ],
  },
  server: {
    host: '0.0.0.0', // Listen on all interfaces (IPv4 and IPv6)
    port: 5173,
    strictPort: true, // Fail loudly if 5173 is taken (e.g. stale server) instead of silently coexisting
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        secure: false
      }
    },
    hmr: {
      overlay: true, // Show error overlay in browser
    },
    fs: {
      allow: [
        '.',
        '../../Framework/frontend',
        '../../node_modules',
      ],
    },
  },
  // Log errors to terminal
  clearScreen: false, // Don't clear terminal on rebuild
  logLevel: 'info', // Show info, warnings, and errors

  // Enhanced error handling
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress circular dependency warnings from third-party libs
        if (warning.code === 'CIRCULAR_DEPENDENCY') return;
        console.warn('\n⚠️  Build Warning:', warning.message);
        warn(warning);
      },
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/scheduler/')) {
            return 'vendor-react';
          }
          // MUI (largest single vendor)
          if (id.includes('node_modules/@mui/') || id.includes('node_modules/@emotion/')) {
            return 'vendor-mui';
          }
          // Recharts + D3 (already large on its own — keep isolated)
          if (id.includes('node_modules/recharts/') || id.includes('node_modules/d3') || id.includes('node_modules/victory-vendor/')) {
            return 'vendor-recharts';
          }
          // ApexCharts
          if (id.includes('node_modules/apexcharts/') || id.includes('node_modules/react-apexcharts/')) {
            return 'vendor-apexcharts';
          }
          // Grid layout
          if (id.includes('node_modules/react-grid-layout/') || id.includes('node_modules/react-resizable/')) {
            return 'vendor-grid';
          }
          // Routing
          if (id.includes('node_modules/react-router') || id.includes('node_modules/@remix-run/')) {
            return 'vendor-router';
          }
          // HTTP + state
          if (id.includes('node_modules/axios/') || id.includes('node_modules/zustand/')) {
            return 'vendor-state';
          }
          // Remaining node_modules → shared vendor chunk
          if (id.includes('node_modules/')) {
            return 'vendor-misc';
          }
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
  // Base path: /MeterItPro/ when deploying to GitHub Pages, / otherwise
  base: process.env.VITE_BASE_PATH ?? '/',
});
