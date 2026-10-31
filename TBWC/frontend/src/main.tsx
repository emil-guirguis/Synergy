import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { BrowserRouter } from 'react-router-dom';
import { ColorModeProvider, useColorMode } from '@meterit/framework-frontend/theme/ColorModeContext';
import { createTbwcTheme } from './theme/tbwcTheme';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import './index.css';

// Subpath deploy: BASE_URL is set by vite `base` (e.g. "/Synergy/TBWCPortal/") so the
// router must scope routes under it. Strip the trailing slash React Router doesn't want;
// at root ("/") this collapses to undefined = default "/".
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || undefined;

// GitHub Pages serves this app as static files, so a deep link (/portal/orders/12)
// is a 404 at the server — the site's 404.html stashes the path here and bounces to
// /portal/. Put it back in the address bar before the router reads location, so the
// rep lands on the page they asked for instead of the dashboard.
try {
  const stashed = sessionStorage.getItem('portal:redirect');
  if (stashed) {
    sessionStorage.removeItem('portal:redirect');
    window.history.replaceState(null, '', (basename ?? '') + stashed);
  }
} catch {
  /* storage blocked — land on the portal root */
}

// Has to be a child of ColorModeProvider: the MUI theme is rebuilt whenever the
// resolved mode changes, so it can't be constructed at module scope.
function ThemedApp() {
  const { mode } = useColorMode();
  const theme = useMemo(() => createTbwcTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorModeProvider>
      <ThemedApp />
    </ColorModeProvider>
  </StrictMode>
);
