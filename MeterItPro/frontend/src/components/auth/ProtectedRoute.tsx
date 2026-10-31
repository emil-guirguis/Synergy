import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { LoadingSpinner } from '@meterit/framework-frontend/components/common';

interface ProtectedRouteProps {
  children: ReactNode;
  fallback?: ReactNode;
  redirectTo?: string;
}

/**
 * ProtectedRoute component that requires authentication
 * Redirects to login page if user is not authenticated
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  fallback,
  redirectTo = '/login',
}) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();


  // Show loading spinner while checking authentication
  if (isLoading) {
    return fallback || <LoadingSpinner message="Checking authentication..." fullScreen />;
  }

  // Redirect to login if not authenticated
  if (!isAuthenticated) {
    return (
      <Navigate
        to={redirectTo}
        state={{ from: location }}
        replace
      />
    );
  }

  // Render protected content
  return <>{children}</>;
};

export default ProtectedRoute;