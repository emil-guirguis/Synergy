import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ThemeProvider, CssBaseline } from '@mui/material';
import { BrowserRouter } from 'react-router-dom';
import { tbwcTheme } from './theme/tbwcTheme';
import { AuthProvider } from './contexts/AuthContext';
import App from './App';
import './index.css';

// Subpath deploy: BASE_URL is set by vite `base` (e.g. "/Synergy/TBWCPortal/") so the
// router must scope routes under it. Strip the trailing slash React Router doesn't want;
// at root ("/") this collapses to undefined = default "/".
const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || undefined;

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={tbwcTheme}>
      <CssBaseline />
      <BrowserRouter basename={basename}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </ThemeProvider>
  </StrictMode>
);
