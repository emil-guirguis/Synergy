import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Box,
  Card,
  CardContent,
  TextField,
  Button,
  Typography,
  Alert,
  CircularProgress,
  Container,
  Link,
  LinearProgress,
  List,
  ListItem,
  ListItemIcon,
  ListItemText,
  IconButton,
  InputAdornment,
} from '@mui/material';
import { useTheme, useMediaQuery } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import CancelIcon from '@mui/icons-material/Cancel';
import VisibilityIcon from '@mui/icons-material/Visibility';
import VisibilityOffIcon from '@mui/icons-material/VisibilityOff';
import { authService } from '../../services/authService';
import { Turnstile } from '../../components/auth/Turnstile';

interface PasswordRequirement {
  label: string;
  met: boolean;
}

const PasswordResetPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Form state
  const [token, setToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  // UI state
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isValidatingToken, setIsValidatingToken] = useState(true);
  const [turnstileToken, setTurnstileToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [passwordRequirements, setPasswordRequirements] = useState<PasswordRequirement[]>([
    { label: 'At least 12 characters', met: false },
    { label: 'At least one uppercase letter (A-Z)', met: false },
    { label: 'At least one lowercase letter (a-z)', met: false },
    { label: 'At least one number (0-9)', met: false },
    { label: 'At least one special character (!@#$%^&*)', met: false },
  ]);

  // Extract and validate token on page load
  useEffect(() => {
    const tokenParam = searchParams.get('token');
    if (!tokenParam) {
      setError('Reset link is invalid or missing. Please request a new password reset link.');
      setIsValidatingToken(false);
      return;
    }

    setToken(tokenParam);
    setIsValidatingToken(false);
  }, [searchParams]);

  // Update password requirements as user types
  useEffect(() => {
    if (!newPassword) {
      setPasswordRequirements(
        passwordRequirements.map((req) => ({ ...req, met: false }))
      );
      return;
    }

    const requirements = [
      { label: 'At least 12 characters', met: newPassword.length >= 12 },
      { label: 'At least one uppercase letter (A-Z)', met: /[A-Z]/.test(newPassword) },
      { label: 'At least one lowercase letter (a-z)', met: /[a-z]/.test(newPassword) },
      { label: 'At least one number (0-9)', met: /[0-9]/.test(newPassword) },
      { label: 'At least one special character (!@#$%^&*)', met: /[!@#$%^&*]/.test(newPassword) },
    ];

    setPasswordRequirements(requirements);
  }, [newPassword]);

  // Calculate password strength
  const getPasswordStrength = (): { score: number; label: string; color: string } => {
    if (!newPassword) return { score: 0, label: '', color: 'inherit' };

    const metRequirements = passwordRequirements.filter((req) => req.met).length;
    const score = (metRequirements / passwordRequirements.length) * 100;

    if (score < 40) {
      return { score, label: 'Weak', color: '#d32f2f' };
    } else if (score < 80) {
      return { score, label: 'Fair', color: '#f57c00' };
    } else {
      return { score, label: 'Strong', color: '#388e3c' };
    }
  };

  const passwordStrength = getPasswordStrength();
  const allRequirementsMet = passwordRequirements.every((req) => req.met);
  const passwordsMatch = newPassword && confirmPassword && newPassword === confirmPassword;

  // Handle form submission
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // Validate form
    if (!token) {
      setError('Reset link is invalid. Please request a new password reset link.');
      return;
    }

    if (!newPassword) {
      setError('New password is required');
      return;
    }

    if (!confirmPassword) {
      setError('Password confirmation is required');
      return;
    }

    if (!passwordsMatch) {
      setError('Passwords do not match');
      return;
    }

    if (!allRequirementsMet) {
      setError('Password does not meet all security requirements');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await authService.resetPassword(token, newPassword, confirmPassword, turnstileToken);
      setSuccess(true);
      setNewPassword('');
      setConfirmPassword('');

      // Redirect to login after 3 seconds
      setTimeout(() => {
        navigate('/login');
      }, 3000);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to reset password';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isValidatingToken) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          background: isMobile
            ? theme.palette.background.default
            : `linear-gradient(135deg, ${theme.palette.primary.main}20 0%, ${theme.palette.secondary.main}20 100%)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
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
            <CircularProgress />
            <Typography variant="body1" sx={{ mt: 2 }}>
              Validating reset link...
            </Typography>
          </Box>
        </Container>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: '100vh',
        background: isMobile
          ? theme.palette.background.default
          : `linear-gradient(135deg, ${theme.palette.primary.main}20 0%, ${theme.palette.secondary.main}20 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
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
          <Card
            sx={{
              width: '100%',
              maxWidth: 400,
              boxShadow: 3,
              backgroundColor: '#ffffff',
            }}
          >
            <CardContent sx={{ p: 4 }}>
              {/* Header */}
              <Box sx={{ textAlign: 'center', mb: 3 }}>
                <Typography variant="h4" component="h1" gutterBottom sx={{ color: '#1a1a1a', fontWeight: 600 }}>
                  Reset Password
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ color: '#666' }}>
                  Enter your new password below
                </Typography>
              </Box>

              {/* Error Alert */}
              {error && !success && (
                <Alert severity="error" sx={{ mb: 3 }}>
                  {error}
                </Alert>
              )}

              {/* Success Message */}
              {success && (
                <Alert severity="success" sx={{ mb: 3 }}>
                  Password reset successfully! Redirecting to login...
                </Alert>
              )}

              {/* Form */}
              {!success && !error ? (
                <Box component="form" onSubmit={handleSubmit} noValidate sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* New Password Field */}
                  <TextField
                    margin="normal"
                    required
                    fullWidth
                    id="newPassword"
                    label="New Password"
                    name="newPassword"
                    type={showNewPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    autoFocus
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    disabled={isSubmitting}
                    variant="outlined"
                    InputLabelProps={{
                      shrink: true,
                    }}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label="toggle password visibility"
                            onClick={() => setShowNewPassword(!showNewPassword)}
                            edge="end"
                            disabled={isSubmitting}
                          >
                            {showNewPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                          </IconButton>
                        </InputAdornment>
                      ),
                    }}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        backgroundColor: '#ffffff !important',
                        '& fieldset': {
                          borderColor: '#cccccc',
                        },
                        '&:hover fieldset': {
                          borderColor: '#1976d2',
                        },
                        '&.Mui-focused fieldset': {
                          borderColor: '#1976d2',
                        },
                      },
                      '& .MuiInputBase-input': {
                        color: '#000000 !important',
                        fontSize: '16px',
                        backgroundColor: '#ffffff !important',
                      },
                      '& .MuiInputLabel-root': {
                        color: '#666666',
                        fontSize: '14px',
                      },
                      '& .MuiInputLabel-root.Mui-focused': {
                        color: '#1976d2',
                      },
                    }}
                  />

                  {/* Password Strength Indicator */}
                  {newPassword && (
                    <Box sx={{ mt: 1 }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>
                          Password Strength
                        </Typography>
                        <Typography
                          variant="caption"
                          sx={{
                            fontWeight: 600,
                            color: passwordStrength.color,
                          }}
                        >
                          {passwordStrength.label}
                        </Typography>
                      </Box>
                      <LinearProgress
                        variant="determinate"
                        value={passwordStrength.score}
                        sx={{
                          height: 8,
                          borderRadius: 4,
                          backgroundColor: '#e0e0e0',
                          '& .MuiLinearProgress-bar': {
                            backgroundColor: passwordStrength.color,
                            borderRadius: 4,
                          },
                        }}
                      />
                    </Box>
                  )}

                  {/* Password Requirements */}
                  {newPassword && (
                    <Box sx={{ mt: 2 }}>
                      <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                        Password Requirements
                      </Typography>
                      <List sx={{ p: 0 }}>
                        {passwordRequirements.map((req, index) => (
                          <ListItem key={index} sx={{ p: 0.5, minHeight: 'auto' }}>
                            <ListItemIcon sx={{ minWidth: 32 }}>
                              {req.met ? (
                                <CheckCircleIcon sx={{ color: '#388e3c', fontSize: 20 }} />
                              ) : (
                                <CancelIcon sx={{ color: '#d32f2f', fontSize: 20 }} />
                              )}
                            </ListItemIcon>
                            <ListItemText
                              primary={req.label}
                              primaryTypographyProps={{
                                variant: 'body2',
                                sx: {
                                  color: req.met ? '#388e3c' : '#d32f2f',
                                  fontSize: '14px'
                                }
                              }}
                            />
                          </ListItem>
                        ))}
                      </List>
                    </Box>
                  )}

                  {/* Confirm Password Field */}
                  <TextField
                    margin="normal"
                    required
                    fullWidth
                    id="confirmPassword"
                    label="Confirm Password"
                    name="confirmPassword"
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={isSubmitting}
                    variant="outlined"
                    InputLabelProps={{
                      shrink: true,
                    }}
                    InputProps={{
                      endAdornment: (
                        <InputAdornment position="end">
                          <IconButton
                            aria-label="toggle password visibility"
                            onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                            edge="end"
                            disabled={isSubmitting}
                          >
                            {showConfirmPassword ? <VisibilityOffIcon /> : <VisibilityIcon />}
                          </IconButton>
                        </InputAdornment>
                      ),
                    }}
                    sx={{
                      '& .MuiOutlinedInput-root': {
                        backgroundColor: '#ffffff !important',
                        '& fieldset': {
                          borderColor: '#cccccc',
                        },
                        '&:hover fieldset': {
                          borderColor: '#1976d2',
                        },
                        '&.Mui-focused fieldset': {
                          borderColor: '#1976d2',
                        },
                      },
                      '& .MuiInputBase-input': {
                        color: '#000000 !important',
                        fontSize: '16px',
                        backgroundColor: '#ffffff !important',
                      },
                      '& .MuiInputLabel-root': {
                        color: '#666666',
                        fontSize: '14px',
                      },
                      '& .MuiInputLabel-root.Mui-focused': {
                        color: '#1976d2',
                      },
                    }}
                  />

                  {/* Password Match Indicator */}
                  {confirmPassword && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      {passwordsMatch ? (
                        <>
                          <CheckCircleIcon sx={{ color: '#388e3c', fontSize: 20 }} />
                          <Typography variant="body2" sx={{ color: '#388e3c' }}>
                            Passwords match
                          </Typography>
                        </>
                      ) : (
                        <>
                          <CancelIcon sx={{ color: '#d32f2f', fontSize: 20 }} />
                          <Typography variant="body2" sx={{ color: '#d32f2f' }}>
                            Passwords do not match
                          </Typography>
                        </>
                      )}
                    </Box>
                  )}

                  <Turnstile
                    onVerify={(token) => setTurnstileToken(token)}
                    onExpire={() => setTurnstileToken('')}
                  />

                  {/* Submit Button */}
                  <Button
                    type="submit"
                    fullWidth
                    variant="contained"
                    size="large"
                    disabled={isSubmitting || !allRequirementsMet || !passwordsMatch || !turnstileToken}
                    sx={{
                      mt: 2,
                      mb: 2,
                      height: 48,
                      position: 'relative',
                    }}
                  >
                    {isSubmitting && (
                      <CircularProgress
                        size={20}
                        sx={{
                          position: 'absolute',
                          left: '50%',
                          top: '50%',
                          marginLeft: '-10px',
                          marginTop: '-10px',
                        }}
                      />
                    )}
                    {isSubmitting ? 'Resetting...' : 'Reset Password'}
                  </Button>

                  {/* Back to Login Link */}
                  <Box sx={{ textAlign: 'center', mt: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      Remember your password?{' '}
                      <Link
                        component="button"
                        variant="body2"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate('/login');
                        }}
                        sx={{ cursor: 'pointer', textDecoration: 'none', color: '#1976d2' }}
                      >
                        Back to Login
                      </Link>
                    </Typography>
                  </Box>
                </Box>
              ) : error ? (
                <Box sx={{ textAlign: 'center' }}>
                  {/* Request new reset link */}
                  <Box sx={{ mt: 3 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      The reset link has expired or is invalid.
                    </Typography>
                    <Button
                      variant="outlined"
                      fullWidth
                      onClick={() => {
                        navigate('/forgot-password');
                      }}
                      sx={{ mb: 2 }}
                    >
                      Request New Reset Link
                    </Button>
                    <Typography variant="body2" color="text.secondary">
                      <Link
                        component="button"
                        variant="body2"
                        onClick={(e) => {
                          e.preventDefault();
                          navigate('/login');
                        }}
                        sx={{ cursor: 'pointer', textDecoration: 'none', color: '#1976d2' }}
                      >
                        Back to Login
                      </Link>
                    </Typography>
                  </Box>
                </Box>
              ) : null}
            </CardContent>
          </Card>

          {/* Footer */}
          <Box sx={{ mt: 4, textAlign: 'center' }}>
            <Typography variant="body2" color="text.secondary">
              © {new Date().getFullYear()} MeterIt Pro. All rights reserved.
            </Typography>
          </Box>
        </Box>
      </Container>
    </Box>
  );
};

export default PasswordResetPage;
