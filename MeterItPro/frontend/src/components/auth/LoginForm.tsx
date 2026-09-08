import React, { useState, useCallback } from 'react';
import { Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { LoginForm as BaseLoginForm, type LoginFormCredentials } from '@framework/components/auth/LoginForm';
import { useAuth } from '../../hooks/useAuth';
import { TwoFactorVerificationModal } from './TwoFactorVerificationModal';
import { Turnstile } from './Turnstile';
import authService from '../../services/authService';
import { getVersionDisplay } from '../../utils/version';

interface LoginFormProps {
  onSuccess?: (response?: any) => void;
  redirectTo?: string;
  prefilledEmail?: string;
  prefilledPassword?: string;
  successMessage?: string;
  additionalError?: string;
}

export const LoginForm: React.FC<LoginFormProps> = ({
  onSuccess,
  redirectTo = '/dashboard',
  prefilledEmail = '',
  prefilledPassword = '',
  successMessage = '',
  additionalError = '',
}) => {
  const { login, isLoading, error } = useAuth();
  const navigate = useNavigate();

  const [turnstileToken, setTurnstileToken] = useState('');
  const handleTurnstileVerify = useCallback((token: string) => setTurnstileToken(token), []);
  const handleTurnstileExpire = useCallback(() => setTurnstileToken(''), []);

  const [requires2FA, setRequires2FA] = useState(false);
  const [sessionToken, setSessionToken] = useState('');
  const [twoFAMethod, setTwoFAMethod] = useState<'totp' | 'email_otp' | 'sms_otp'>('totp');
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);

  const handleSubmit = async (credentials: LoginFormCredentials) => {
    setRememberMe(credentials.rememberMe);
    const response = await login({ ...credentials, turnstileToken });

    if (response.requires_2fa && response.session_token) {
      setSessionToken(response.session_token);
      setTwoFAMethod(response.twofa_method || 'totp');
      setRequires2FA(true);
      setShow2FAModal(true);
      return;
    }

    console.log('✅ Login successful, redirecting to:', redirectTo);
    onSuccess?.(response);
  };

  const handle2FASuccess = async (authResponse: any) => {
    try {
      authService.storeTokens(authResponse.token, authResponse.refreshToken, authResponse.expiresIn, rememberMe);
      localStorage.setItem('tenantId', authResponse.user.client);
      setShow2FAModal(false);
      setRequires2FA(false);
      setSessionToken('');
      onSuccess?.();
    } catch (err) {
      console.error('2FA success handler error:', err);
    }
  };

  const handle2FAClose = () => {
    setShow2FAModal(false);
    setRequires2FA(false);
    setSessionToken('');
  };

  return (
    <>
      <BaseLoginForm
        onSubmit={handleSubmit}
        prefilledEmail={prefilledEmail}
        prefilledPassword={prefilledPassword}
        successMessage={successMessage}
        errorMessage={additionalError || error || ''}
        disabled={isLoading || requires2FA}
        submitDisabled={!turnstileToken}
        onForgotPasswordClick={() => navigate('/forgot-password')}
        extraSlot={<Turnstile onVerify={handleTurnstileVerify} onExpire={handleTurnstileExpire} />}
        footer={
          <>
            <Typography variant="body2" color="text.secondary">
              © 2025 MeterIt Pro. All rights reserved.
            </Typography>
            <Typography variant="caption" color="text.disabled">
              {getVersionDisplay()}
            </Typography>
          </>
        }
      />

      {show2FAModal && (
        <TwoFactorVerificationModal
          open={show2FAModal}
          sessionToken={sessionToken}
          method={twoFAMethod}
          onSuccess={handle2FASuccess}
          onClose={handle2FAClose}
        />
      )}
    </>
  );
};

export default LoginForm;
