import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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
} from '@mui/material';
import { useTheme, useMediaQuery } from '@mui/material';
import { authService } from '../../services/authService';
import { Turnstile } from '../../components/auth/Turnstile';

const ForgotPasswordPage: React.FC = () => {
  const navigate = useNavigate();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('md'));

  // Form state
  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');

  // Handle form submission
  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    // Validate email
    if (!email || !email.includes('@')) {
      setError('Please enter a valid email address');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      await authService.forgotPassword(email, turnstileToken);
      setSuccess(true);
      setEmail('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to request password reset';
      setError(message);
    } finally {
      setIsSubmitting(false);
    }
  };

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
                  Enter your email address and we'll send you a link to reset your password
                </Typography>
              </Box>

              {/* Success Message */}
              {success && (
                <Alert severity="success" sx={{ mb: 3 }}>
                  If an account exists with this email, you will receive a password reset link shortly. Please check your email.
                </Alert>
              )}

              {/* Error Alert */}
              {error && !success && (
                <Alert severity="error" sx={{ mb: 3 }}>
                  {error}
                </Alert>
              )}

              {/* Form */}
              {!success ? (
                <Box component="form" onSubmit={handleSubmit} noValidate sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {/* Email Field */}
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
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    disabled={isSubmitting}
                    variant="outlined"
                    InputLabelProps={{
                      shrink: true,
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
                      '& .MuiInputBase-input::placeholder': {
                        color: '#999999',
                        opacity: 1,
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
                    disabled={isSubmitting || !turnstileToken}
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
                    {isSubmitting ? 'Sending...' : 'Send Reset Link'}
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
              ) : (
                <Box sx={{ textAlign: 'center' }}>
                  {/* Back to Login Link after success */}
                  <Box sx={{ mt: 3 }}>
                    <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                      Didn't receive an email?
                    </Typography>
                    <Button
                      variant="outlined"
                      fullWidth
                      onClick={() => {
                        setSuccess(false);
                        setEmail('');
                      }}
                      sx={{ mb: 2 }}
                    >
                      Try Again
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
              )}
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

export default ForgotPasswordPage;
