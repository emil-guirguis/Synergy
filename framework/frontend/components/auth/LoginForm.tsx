import React, { useState, useEffect } from 'react';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  FormControlLabel,
  Checkbox,
  IconButton,
  InputAdornment,
  Alert,
  CircularProgress,
  Container,
  Link,
} from '@mui/material';
import Visibility from '@mui/icons-material/Visibility';
import VisibilityOff from '@mui/icons-material/VisibilityOff';

export interface LoginFormCredentials {
  email: string;
  password: string;
  rememberMe: boolean;
}

interface FieldError {
  field: 'email' | 'password';
  message: string;
}

function validateCredentials(credentials: LoginFormCredentials): FieldError[] {
  const errors: FieldError[] = [];
  if (!credentials.email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.email)) {
    errors.push({ field: 'email', message: 'Please enter a valid email address' });
  }
  if (!credentials.password) {
    errors.push({ field: 'password', message: 'Password is required' });
  }
  return errors;
}

export interface LoginFormProps {
  title?: string;
  subtitle?: string;
  /** Called with the submitted credentials. App owns the actual auth call, error handling, and post-login navigation. */
  onSubmit: (credentials: LoginFormCredentials) => Promise<void> | void;
  prefilledEmail?: string;
  prefilledPassword?: string;
  /** Dismissible success banner, e.g. after signup redirect. */
  successMessage?: string;
  /** Persistent error banner, e.g. useAuth().error. */
  errorMessage?: string;
  /** Externally forces all fields + submit disabled (e.g. a 2FA modal is open). */
  disabled?: boolean;
  /** Extra content rendered between "remember me" and the submit button (e.g. a captcha widget). */
  extraSlot?: React.ReactNode;
  /** Additional condition gating the submit button beyond field validation (e.g. captcha not yet verified). */
  submitDisabled?: boolean;
  /** Shows a "Forgot your password?" link when provided; caller owns navigation. */
  onForgotPasswordClick?: () => void;
  /** Rendered below the card (copyright, version, etc). */
  footer?: React.ReactNode;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  title = 'Sign In',
  subtitle = 'Enter your credentials to access your account',
  onSubmit,
  prefilledEmail = '',
  prefilledPassword = '',
  successMessage = '',
  errorMessage = '',
  disabled = false,
  extraSlot,
  submitDisabled = false,
  onForgotPasswordClick,
  footer,
}) => {
  const [credentials, setCredentials] = useState<LoginFormCredentials>({
    email: prefilledEmail,
    password: prefilledPassword,
    rememberMe: false,
  });
  const [dismissibleSuccess, setDismissibleSuccess] = useState(successMessage);
  const [showPassword, setShowPassword] = useState(false);
  const [validationErrors, setValidationErrors] = useState<FieldError[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (validationErrors.length > 0) setValidationErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [credentials.email, credentials.password]);

  const isDisabled = disabled || isSubmitting;

  const handleInputChange =
    (field: keyof LoginFormCredentials) => (event: React.ChangeEvent<HTMLInputElement>) => {
      const value = field === 'rememberMe' ? event.target.checked : event.target.value;
      setCredentials((prev) => ({ ...prev, [field]: value as never }));
    };

  const getFieldError = (field: 'email' | 'password') =>
    validationErrors.find((e) => e.field === field)?.message;
  const hasFieldError = (field: 'email' | 'password') =>
    validationErrors.some((e) => e.field === field);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const errors = validateCredentials(credentials);
    if (errors.length > 0) {
      setValidationErrors(errors);
      return;
    }
    setIsSubmitting(true);
    try {
      await onSubmit(credentials);
    } catch (err) {
      console.error('Login failed:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Container component="main" maxWidth="sm">
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          py: 3,
        }}
      >
        <Card sx={{ width: '100%', maxWidth: 400, boxShadow: 3 }}>
          <CardContent sx={{ p: 4 }}>
            <Box sx={{ textAlign: 'center', mb: 3 }}>
              <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: 600 }}>
                {title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            </Box>

            {dismissibleSuccess && (
              <Alert severity="success" sx={{ mb: 2 }} onClose={() => setDismissibleSuccess('')}>
                {dismissibleSuccess}
              </Alert>
            )}

            {errorMessage && (
              <Alert severity="error" sx={{ mb: 2 }}>
                {errorMessage}
              </Alert>
            )}

            <Box
              component="form"
              onSubmit={handleSubmit}
              noValidate
              sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
            >
              <TextField
                margin="normal"
                required
                fullWidth
                id="email"
                label="Email Address"
                name="email"
                autoComplete="email"
                autoFocus
                type="email"
                value={credentials.email}
                onChange={handleInputChange('email')}
                error={hasFieldError('email')}
                helperText={getFieldError('email')}
                disabled={isDisabled}
                variant="outlined"
                InputLabelProps={{ shrink: true }}
              />

              <TextField
                margin="normal"
                required
                fullWidth
                name="password"
                label="Password"
                id="password"
                autoComplete="current-password"
                type={showPassword ? 'text' : 'password'}
                value={credentials.password}
                onChange={handleInputChange('password')}
                error={hasFieldError('password')}
                helperText={getFieldError('password')}
                disabled={isDisabled}
                variant="outlined"
                InputLabelProps={{ shrink: true }}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        onClick={() => setShowPassword((v) => !v)}
                        edge="end"
                        disabled={isDisabled}
                        tabIndex={-1}
                      >
                        {showPassword ? <VisibilityOff /> : <Visibility />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }}
              />

              <FormControlLabel
                control={
                  <Checkbox
                    checked={credentials.rememberMe}
                    onChange={handleInputChange('rememberMe')}
                    name="rememberMe"
                    color="primary"
                    disabled={isDisabled}
                  />
                }
                label="Remember me"
              />

              {extraSlot}

              <Button
                type="submit"
                fullWidth
                variant="contained"
                size="large"
                disabled={isDisabled || submitDisabled}
                sx={{ mt: 2, mb: 2, height: 48, position: 'relative' }}
              >
                {isSubmitting && (
                  <CircularProgress
                    size={20}
                    sx={{ position: 'absolute', left: '50%', top: '50%', marginLeft: '-10px', marginTop: '-10px' }}
                  />
                )}
                {isSubmitting ? 'Signing In...' : 'Sign In'}
              </Button>

              {onForgotPasswordClick && (
                <Box sx={{ textAlign: 'center', mt: 2 }}>
                  <Typography variant="body2" color="text.secondary">
                    Forgot your password?{' '}
                    <Link
                      component="button"
                      type="button"
                      variant="body2"
                      onClick={onForgotPasswordClick}
                      sx={{ cursor: 'pointer', textDecoration: 'none' }}
                    >
                      Reset Password
                    </Link>
                  </Typography>
                </Box>
              )}
            </Box>
          </CardContent>
        </Card>

        {footer && <Box sx={{ mt: 4, textAlign: 'center' }}>{footer}</Box>}
      </Box>
    </Container>
  );
};

export default LoginForm;
