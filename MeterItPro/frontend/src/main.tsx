import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { HelmetProvider } from 'react-helmet-async';
import { ColorModeProvider, useColorMode } from '@meterit/framework-frontend/theme/ColorModeContext';
import './index.css';
import App from './App.tsx';
import { AuthProvider } from './contexts/AuthContext';
import { createMipTheme } from './theme/muiTheme';
import { ErrorBoundary } from './components/ErrorBoundary';

// Vite injects BASE_URL: '/' in dev, '/Synergy/' on GitHub Pages.
// React Router needs it (without trailing slash) as basename so deep
// routes resolve and <Link>/navigate emit base-prefixed URLs in prod.
const routerBasename = import.meta.env.BASE_URL.replace(/\/$/, '');

// Has to be a child of ColorModeProvider: the MUI theme is rebuilt whenever the
// resolved mode changes, so it can't be constructed at module scope.
function ThemedApp() {
  const { mode } = useColorMode();
  const theme = useMemo(() => createMipTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <HelmetProvider>
        <BrowserRouter basename={routerBasename}>
          <ColorModeProvider>
            <ThemedApp />
          </ColorModeProvider>
        </BrowserRouter>
      </HelmetProvider>
    </ErrorBoundary>
  </StrictMode>
);
