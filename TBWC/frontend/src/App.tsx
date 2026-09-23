import { useLocation } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import '@meterit/framework-frontend/components/common/TableCellStyles.css';
import { useAuth } from './hooks/useAuth';
import AppLayoutWrapper from './components/layout/AppLayoutWrapper';
import AppRoutes from './routes/AppRoutes';
import LoginPage from './pages/LoginPage';
import VerifyEmailPage from './pages/VerifyEmailPage';
import { setupDebugConsole } from './utils/debugConsole';

setupDebugConsole();

export default function App() {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  // Reached via the mailed re-verification link with no session — must render
  // ahead of the login gate below. See TBWC/api/worker/reverification.ts.
  if (location.pathname === '/verify') return <VerifyEmailPage />;

  if (isLoading) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
      >
        <CircularProgress />
      </Box>
    );
  }

  if (!isAuthenticated) return <LoginPage />;

  return (
    <AppLayoutWrapper>
      <AppRoutes />
    </AppLayoutWrapper>
  );
}
