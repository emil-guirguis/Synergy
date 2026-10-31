import { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  Typography,
  Box,
  CircularProgress,
  Alert,
  Chip,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
} from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import BusinessIcon from '@mui/icons-material/Business';
import LoginIcon from '@mui/icons-material/Login';
import WarningIcon from '@mui/icons-material/Warning';
import axios, { AxiosError } from 'axios';
import { useAppStore } from '../stores/useAppStore';
import { tenantApi } from '../api/services';
import { authApi } from '../api/auth';
import { TenantInfo } from '../types';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import ConnectionStatusIndicator from './ConnectionStatusIndicator';
import { ConnectionState } from '../types/connection';

/**
 * Extract user-friendly error messages from various error types
 */
function getErrorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    if (err.code === 'ECONNABORTED') {
      return 'Connection timeout. Please check if the sync service is running.';
    }
    if (err.code === 'ECONNREFUSED' || err.code === 'ERR_NETWORK') {
      return 'Cannot reach the sync service. Please ensure it is running and accessible.';
    }
    if (err.response?.status === 404) {
      return 'Tenant information not found. Please connect your account to continue.';
    }
    if (err.response?.status === 500) {
      return 'Server error occurred. Please try again later or contact support.';
    }
    if (err.response?.status === 503) {
      return 'Sync service is temporarily unavailable. Please try again in a moment.';
    }
    if (err.message === 'Network Error') {
      return 'Network connection error. Please check your internet connection.';
    }
    return err.response?.data?.message || err.message || 'Failed to fetch tenant information';
  }
  if (err instanceof Error) {
    return err.message;
  }
  return 'An unexpected error occurred';
}

/**
 * Validate tenant data structure
 */
function isValidTenantInfo(data: unknown): data is TenantInfo {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const obj = data as Record<string, unknown>;
  return (
    (typeof obj.tenant_id === 'number' || typeof obj.tenant_id === 'string') &&
    typeof obj.name === 'string' &&
    obj.name.trim().length > 0
  );
}

/**
 * Login Modal Component
 */
interface LoginModalProps {
  open: boolean;
  isLoggingIn: boolean;
  loginError: string | null;
  loginData: { email: string; apiKey: string };
  onClose: () => void;
  onLoginDataChange: (data: { email: string; apiKey: string }) => void;
  onLogin: () => Promise<void>;
}

function LoginModal({
  open,
  isLoggingIn,
  loginError,
  loginData,
  onClose,
  onLoginDataChange,
  onLogin,
}: LoginModalProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Connect to Your Account</DialogTitle>
      <DialogContent sx={{ pt: 2 }}>
        {loginError && (
          <Alert severity="error" sx={{ mb: 2 }}>
            {loginError}
          </Alert>
        )}
        <TextField
          fullWidth
          label="Email"
          type="email"
          value={loginData.email}
          onChange={(e) => onLoginDataChange({ ...loginData, email: e.target.value })}
          margin="normal"
          placeholder="Enter your account email"
          disabled={isLoggingIn}
          autoComplete="email"
          helperText="The email address associated with the account"
        />
        <TextField
          fullWidth
          label="API Key"
          value={loginData.apiKey}
          onChange={(e) => onLoginDataChange({ ...loginData, apiKey: e.target.value })}
          margin="normal"
          placeholder="Enter your API key from signup"
          disabled={isLoggingIn}
          helperText="The API key you received when you signed up"
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={isLoggingIn}>
          Cancel
        </Button>
        <Button
          variant="contained"
          onClick={onLogin}
          disabled={isLoggingIn || !loginData.email || !loginData.apiKey}
        >
          {isLoggingIn ? 'Connecting...' : 'Connect'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Connection Status Display Component
 */
function ConnectionStatusDisplay() {
  const { status, isRemoteSystemConnected, isLocalSystemConnected } = useConnectionStatus();

  return (
    <>
      <Box mt={3} mb={3} display="flex" gap={2} justifyContent="center" flexWrap="wrap">
        <ConnectionStatusIndicator
          label="Sync API"
          state={status.syncApi}
          tooltip={
            status.syncApi === ConnectionState.CONNECTED
              ? 'Sync API server is running and operational'
              : status.syncApi === ConnectionState.DISCONNECTED
                ? 'Sync API server is not running'
                : 'Checking Sync API server...'
          }
        />
        <ConnectionStatusIndicator
          label="MCP Server"
          state={status.mcpServer}
          tooltip={
            status.mcpServer === ConnectionState.CONNECTED
              ? 'MCP server is running and processing data'
              : status.mcpServer === ConnectionState.DISCONNECTED
                ? 'MCP server is not running or inactive'
                : 'Checking MCP server status...'
          }
        />
        <ConnectionStatusIndicator
          label="Local DB"
          state={status.syncDb}
          tooltip={
            status.syncDb === ConnectionState.CONNECTED
              ? 'Local sync database is connected and operational'
              : status.syncDb === ConnectionState.DISCONNECTED
                ? 'Local sync database is not accessible'
                : 'Checking local sync database connection...'
          }
        />
        <ConnectionStatusIndicator
          label="Remote DB"
          state={status.remoteDb}
          tooltip={
            status.remoteDb === ConnectionState.CONNECTED
              ? 'Remote client database is connected and operational'
              : status.remoteDb === ConnectionState.DISCONNECTED
                ? 'Cannot connect to remote client database'
                : 'Checking remote database connection...'
          }
        />
        <ConnectionStatusIndicator
          label="Remote API"
          state={status.remoteApi}
          tooltip={
            status.remoteApi === ConnectionState.CONNECTED
              ? 'Remote Client System API is connected and operational'
              : status.remoteApi === ConnectionState.DISCONNECTED
                ? 'Cannot connect to remote Client System API'
                : 'Checking remote API connection...'
          }
        />
      </Box>

      {!isLocalSystemConnected && (
        <Alert severity="error" sx={{ mb: 2 }} icon={<WarningIcon />}>
          Local sync services are not fully operational. Please ensure the Sync API and MCP servers are running.
        </Alert>
      )}

      {isLocalSystemConnected && !isRemoteSystemConnected && (
        <Alert severity="warning" sx={{ mb: 2 }} icon={<WarningIcon />}>
          Unable to reach remote Client System. Meter readings are being queued locally and will sync when connection is restored.
        </Alert>
      )}
    </>
  );
}

/**
 * Tenant Information Display Component
 */
function TenantInfoDisplay({ tenantInfo }: { tenantInfo: TenantInfo }) {
  return (
    <>
      <Box mt={2}>
        <Typography variant="body2" color="text.secondary" gutterBottom>
          Company Name
        </Typography>
        <Typography variant="body1" fontWeight={500}>
          {tenantInfo.name}
        </Typography>
      </Box>

      {tenantInfo.street && (
        <Box mt={2}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Address
          </Typography>
          <Typography variant="body1">
            {tenantInfo.street}
            {tenantInfo.street2 && <> · {tenantInfo.street2}</>}
            <br />
            {tenantInfo.city && `${tenantInfo.city}, `}
            {tenantInfo.state} {tenantInfo.zip}
            {tenantInfo.country && tenantInfo.country.toLowerCase() !== 'usa' && (
              <>
                <br />
                {tenantInfo.country}
              </>
            )}
          </Typography>
        </Box>
      )}


      {tenantInfo.url && (
        <Box mt={2}>
          <Typography variant="body2" color="text.secondary" gutterBottom>
            Website
          </Typography>
          <Typography variant="body1">
            <a href={tenantInfo.url} target="_blank" rel="noopener noreferrer">
              {tenantInfo.url}
            </a>
          </Typography>
        </Box>
      )}

      <Box mt={3}>
        <Typography variant="caption" color="text.secondary">
          Tenant ID: {tenantInfo.tenant_id}
        </Typography>
      </Box>
    </>
  );
}

/**
 * Main CompanyInfoCard Component
 */
export default function CompanyInfoCard() {
  const { tenantInfo, setTenantInfo } = useAppStore();
  const { isAllConnected } = useConnectionStatus();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [loginData, setLoginData] = useState({ email: '', apiKey: '' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Fetch tenant information on component mount
  useEffect(() => {
    const fetchTenantInfo = async () => {
      try {
        setIsLoading(true);
        setError(null);

        const data = await tenantApi.getTenantInfo();

        if (data !== null && !isValidTenantInfo(data)) {
          setError('Invalid tenant data received. Please try reconnecting your account.');
          console.error('Invalid tenant data:', data);
          return;
        }

        setTenantInfo(data);
      } catch (err) {
        // 404 and 503 are expected when no tenant is configured or service is initializing
        if (axios.isAxiosError(err) && (err.response?.status === 404 || err.response?.status === 503)) {
          // Deliberate one-off notice for an expected branch, not trace chatter.
          // eslint-disable-next-line no-console
          console.info('ℹ️  [Auth] No tenant configured - user needs to login');
          setTenantInfo(null);
          setError(null);
        } else {
          const errorMessage = getErrorMessage(err);
          setError(errorMessage);
          console.error('Failed to fetch tenant info:', err);
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchTenantInfo();
  }, []);

  // The sync API auto-seeds the tenant from the bootstrap endpoint shortly
  // after first boot — poll until it lands so no manual login/refresh is needed.
  useEffect(() => {
    if (tenantInfo || isLoading) return;
    const interval = setInterval(async () => {
      try {
        const data = await tenantApi.getTenantInfo();
        if (data && isValidTenantInfo(data)) {
          setTenantInfo(data);
          setError(null);
        }
      } catch {
        // still not seeded — keep polling
      }
    }, 10_000);
    return () => clearInterval(interval);
  }, [tenantInfo, isLoading]);

  // Handle login and tenant sync
  const handleLogin = async () => {
    try {
      setIsLoggingIn(true);
      setLoginError(null);


      // Call the remote /sync/connect endpoint with email, password, and API key
      const response = await authApi.login(loginData);

      if (!response.success || !response.data?.tenant) {
        setLoginError(response.error || 'Connection failed. Please check your credentials and API key.');
        return;
      }

      const newTenant = response.data.tenant;

      // Otherwise auto-login will fetch the OLD tenant from the local database
      await tenantApi.syncTenantToLocal(newTenant);


      // Use tenant data from response
      setTenantInfo(newTenant);
      setShowLoginModal(false);
      setLoginData({ email: '', apiKey: '' });

      // Refresh the page to load all components with new tenant data
      setTimeout(() => window.location.reload(), 500);
    } catch (err) {
      setLoginError(getErrorMessage(err));
      console.error('❌ [Auth] Connection error:', err);
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Loading state
  if (isLoading) {
    return (
      <Card>
        <CardContent>
          <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
            <CircularProgress size={40} />
          </Box>
        </CardContent>
      </Card>
    );
  }

  // Error state
  if (error && !tenantInfo) {
    return (
      <>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center" gap={2} mb={2}>
              <ErrorIcon color="error" fontSize="large" />
              <Box flex={1}>
                <Typography variant="h6">Company Info & System Status</Typography>
                <Chip label="Error" color="error" size="small" icon={<ErrorIcon />} />
              </Box>
            </Box>
            <ConnectionStatusDisplay />
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
            <Button
              variant="contained"
              startIcon={<LoginIcon />}
              onClick={() => setShowLoginModal(true)}
              fullWidth
            >
              Connect Account
            </Button>
          </CardContent>
        </Card>

        <LoginModal
          open={showLoginModal}
          isLoggingIn={isLoggingIn}
          loginError={loginError}
          loginData={loginData}
          onClose={() => {
            setShowLoginModal(false);
            setLoginError(null);
          }}
          onLoginDataChange={setLoginData}
          onLogin={handleLogin}
        />
      </>
    );
  }

  // Not connected state
  if (!tenantInfo) {
    return (
      <>
        <Card>
          <CardContent>
            <Box display="flex" alignItems="center" gap={2} mb={2}>
              <BusinessIcon color="warning" fontSize="large" />
              <Box flex={1}>
                <Typography variant="h6">Company Info & System Status</Typography>
                <Chip
                  label="Not Connected"
                  color="warning"
                  size="small"
                  icon={<WarningIcon />}
                />
              </Box>
            </Box>
            <ConnectionStatusDisplay />
            <Alert severity="warning" sx={{ mb: 2 }}>
              <Typography variant="body2" sx={{ fontWeight: 'bold', mb: 1 }}>
                No tenant found - Database not initialized
              </Typography>
              <Typography variant="body2">
                Please log in to initialize the database and sync your company information.
              </Typography>
            </Alert>
            <Button
              variant="contained"
              startIcon={<LoginIcon />}
              onClick={() => setShowLoginModal(true)}
              fullWidth
            >
              Log In to Initialize
            </Button>
          </CardContent>
        </Card>

        <LoginModal
          open={showLoginModal}
          isLoggingIn={isLoggingIn}
          loginError={loginError}
          loginData={loginData}
          onClose={() => {
            setShowLoginModal(false);
            setLoginError(null);
          }}
          onLoginDataChange={setLoginData}
          onLogin={handleLogin}
        />
      </>
    );
  }

  // Connected state with tenant info
  return (
    <Card>
      <CardContent>
        <Box display="flex" alignItems="center" gap={2} mb={3}>
          <BusinessIcon color="primary" fontSize="large" />
          <Box flex={1}>
            <Typography variant="h6">Company Info & System Status</Typography>
            <Chip
              icon={isAllConnected ? <CheckCircleIcon /> : <WarningIcon />}
              label={isAllConnected ? 'All Systems Connected' : 'Partial Connectivity'}
              color={isAllConnected ? 'success' : 'warning'}
              size="small"
            />
          </Box>
        </Box>

        <ConnectionStatusDisplay />
        <TenantInfoDisplay tenantInfo={tenantInfo} />

      </CardContent>
    </Card>
  );
}
