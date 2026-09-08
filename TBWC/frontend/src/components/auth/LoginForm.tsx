import React, { useState } from 'react';
import { LoginForm as BaseLoginForm, type LoginFormCredentials } from '@framework/components/auth/LoginForm';
import { useAuth } from '../../hooks/useAuth';

interface LoginFormProps {
  onSuccess?: () => void;
}

export const LoginForm: React.FC<LoginFormProps> = ({ onSuccess }) => {
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (credentials: LoginFormCredentials) => {
    setError(null);
    try {
      await login(credentials);
      onSuccess?.();
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  return (
    <BaseLoginForm
      title="TBWC Portal"
      subtitle="Sign in with your rep account."
      onSubmit={handleSubmit}
      errorMessage={error ?? undefined}
    />
  );
};

export default LoginForm;
