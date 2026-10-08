import axios from 'axios';
import type { AxiosResponse } from 'axios';
import type { LoginCredentials, AuthResponse, User } from '../types/auth';
import type { Location } from '../types/entities';
import { beginImpersonation, endImpersonation } from '@meterit/framework-frontend/auth/impersonation';
import { tokenStorage } from '../utils/tokenStorage';

// API base URL - this would typically come from environment variables
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

class AuthService {
  private apiClient = axios.create({
    baseURL: API_BASE_URL,
    headers: {
      'Content-Type': 'application/json',
    },
  });

  constructor() {
    // Add request interceptor to include auth token
    this.apiClient.interceptors.request.use(
      (config) => {
        const token = tokenStorage.getToken();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Add response interceptor to handle token expiration
    this.apiClient.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Only retry if it's a 401, not already retried, and not a public auth endpoint
        const isPublicAuthEndpoint = originalRequest.url?.includes('/auth/login') ||
          originalRequest.url?.includes('/auth/refresh') ||
          originalRequest.url?.includes('/auth/forgot-password') ||
          originalRequest.url?.includes('/auth/reset-password');
        if (error.response?.status === 401 && !originalRequest._retry && !isPublicAuthEndpoint) {
          originalRequest._retry = true;

          try {
            const refreshToken = tokenStorage.getRefreshToken();
            if (!refreshToken) {
              // No refresh token — clear storage and signal a forced logout
              console.error('[AUTH INTERCEPTOR] 401 received, no refresh token available.');
              tokenStorage.clearTokens();
              window.dispatchEvent(new CustomEvent('auth:force-logout'));
              return Promise.reject(error);
            }

            console.log('[AUTH] Attempting token refresh...');
            const response = await this.refreshToken(refreshToken);
            tokenStorage.updateTokens(response.token, response.refreshToken, response.expiresIn);
            
            // Retry original request with new token
            originalRequest.headers.Authorization = `Bearer ${response.token}`;
            return this.apiClient(originalRequest);
          } catch (refreshError) {
            console.error('[AUTH INTERCEPTOR] Token refresh failed:', refreshError);
            return Promise.reject(refreshError);
          }
        }

        return Promise.reject(error);
      }
    );
  }

  // Login method
  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      console.log('🔐 [LOGIN] Starting login process');
      console.log('🔐 [LOGIN] Credentials:', { email: credentials.email, password: '***' });
      console.log('🔐 [LOGIN] API Client baseURL:', this.apiClient.defaults.baseURL);
      
      let response;
      try {
        response = await this.apiClient.post('/auth/login', credentials);
        console.log('✅ [LOGIN] POST request succeeded');
      } catch (postError) {
        console.error('❌ [LOGIN] POST request failed');
        throw postError;
      }
      
      console.log('✅ [LOGIN] Response received');
      console.log('✅ [LOGIN] Response status:', response.status);
      console.log('✅ [LOGIN] Response data:', response.data);
      
      const authResponse = response.data.data;
      
      console.log('✅ [LOGIN] Extracted authResponse');
      console.log('📋 [LOGIN] User data:', {
        users_id: authResponse.user.users_id,
        email: authResponse.user.email,
        role: authResponse.user.role,
      });
      
      // Store tenant ID in localStorage for form validation field options
      const tenantId = authResponse.user.client;
      console.log('💾 [LOGIN] Tenant ID from response:', tenantId);
      localStorage.setItem('tenantId', tenantId);
      console.log('💾 [LOGIN] Tenant ID stored in localStorage');
      
      // IMPORTANT: Store token FIRST before fetching locations
      console.log('💾 [LOGIN] About to store tokens');
      console.log('💾 [LOGIN] Token:', authResponse.token ? authResponse.token.substring(0, 50) + '...' : 'MISSING');
      console.log('💾 [LOGIN] RefreshToken:', authResponse.refreshToken ? authResponse.refreshToken.substring(0, 50) + '...' : 'MISSING');
      console.log('💾 [LOGIN] ExpiresIn:', authResponse.expiresIn);
      
      this.storeTokens(authResponse.token, authResponse.refreshToken, authResponse.expiresIn);
      
      console.log('💾 [LOGIN] Tokens stored, verifying...');
      console.log('💾 [LOGIN] Token in localStorage:', localStorage.getItem('auth_token') ? 'EXISTS' : 'MISSING');
      console.log('💾 [LOGIN] Token in sessionStorage:', sessionStorage.getItem('auth_token') ? 'EXISTS' : 'MISSING');
      console.log('💾 [LOGIN] getStoredToken():', this.getStoredToken() ? 'EXISTS' : 'MISSING');
      
      // Fetch locations for the user's tenant
      try {
        console.log('📍 [LOGIN] Fetching locations for tenant:', tenantId);
        
        const locationsResponse: AxiosResponse<{ success: boolean; data: { items: Location[]; pagination: any } }> = await this.apiClient.get(
          `/location`
        );
        
        console.log('📍 [LOGIN] Location response received:', locationsResponse.status);
        
        if (locationsResponse.data.success && locationsResponse.data.data?.items) {
          authResponse.locations = locationsResponse.data.data.items;
          console.log('✅ [LOGIN] Locations fetched successfully:', authResponse.locations.length, 'locations');
        } else {
          console.warn('⚠️ [LOGIN] Location response missing items:', locationsResponse.data);
          authResponse.locations = [];
        }
      } catch (locationError) {
        console.warn('⚠️ [LOGIN] Failed to fetch locations, continuing with login:', locationError);
        authResponse.locations = [];
      }
      
      console.log('✅ [LOGIN] Login process completed successfully');
      return authResponse;
    } catch (error) {
      console.error('❌ [LOGIN] Login error caught');
      console.error('❌ [LOGIN] Error type:', error instanceof Error ? error.constructor.name : typeof error);
      console.error('❌ [LOGIN] Error message:', error instanceof Error ? error.message : String(error));
      
      if (axios.isAxiosError(error)) {
        console.error('❌ [LOGIN] Axios error details:');
        console.error('  - Status:', error.response?.status);
        console.error('  - Data:', error.response?.data);
        const message = error.response?.data?.message || 'Login failed';
        throw new Error(message);
      }
      
      console.error('❌ [LOGIN] Non-Axios error:', error);
      throw new Error('Network error occurred');
    }
  }



  // Logout method
  async logout(currentToken?: string | null): Promise<void> {
    try {
      // Clear tenant ID from localStorage
      localStorage.removeItem('tenantId');
      console.log('🗑️ Tenant ID cleared from localStorage');

      // Use explicitly passed token if provided (storage may already be cleared by caller)
      const headers: Record<string, string> = {};
      if (currentToken) {
        headers.Authorization = `Bearer ${currentToken}`;
      }
      await this.apiClient.post('/auth/logout', {}, { headers });
    } catch (error) {
      // Log error but don't throw - logout should always succeed locally
      console.error('Logout API call failed:', error);
    }
  }

  // Refresh token method
  async refreshToken(refreshToken: string): Promise<AuthResponse> {
    try {
      const response: AxiosResponse<{ success: boolean; data: AuthResponse }> = await this.apiClient.post('/auth/refresh', {
        refreshToken,
      });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Token refresh failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Verify token and get user data
  async verifyToken(): Promise<User | null> {
    try {
      const response: AxiosResponse<{ success: boolean; data: { user: User } }> = await this.apiClient.get('/auth/verify');
      return response.data.data.user;
    } catch (error) {
      console.error('Token verification failed:', error);
      return null;
    }
  }

  // Fetch locations for a specific tenant
  async fetchLocations(tenantId: string): Promise<Location[]> {
    try {
      console.log('📍 [AUTH] fetchLocations() called for tenant:', tenantId);
      console.log('📍 [AUTH] API Base URL:', this.apiClient.defaults.baseURL);
      
      // Note: tenant filtering is automatic in the backend via req.user.tenantId
      // We don't need to pass filter.tenant_id as a query parameter
      const response: AxiosResponse<{ success: boolean; data: { items: Location[]; pagination: any } }> = await this.apiClient.get(
        `/location`
      );
      
      console.log('📍 [AUTH] Location response status:', response.status);
      console.log('📍 [AUTH] Location response data:', response.data);
      
      if (response.data.success && response.data.data?.items) {
        console.log('✅ [AUTH] Locations fetched successfully:', response.data.data.items.length, 'locations');
        response.data.data.items.forEach((loc: any, idx: number) => {
          console.log(`  [${idx}] ID: ${loc.id}, Name: ${loc.name}, Tenant: ${loc.tenant_id}`);
        });
        return response.data.data.items;
      } else {
        console.warn('⚠️ [AUTH] Location response missing items:', response.data);
        return [];
      }
    } catch (error) {
      console.error('❌ [AUTH] Failed to fetch locations:', error);
      if (axios.isAxiosError(error)) {
        console.error('❌ [AUTH] Location fetch error details:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
      }
      return [];
    }
  }



  // Token storage methods
  storeTokens(token: string, refreshToken: string, expiresIn: number, rememberMe: boolean = false): void {
    tokenStorage.storeTokens(token, refreshToken, expiresIn, rememberMe);
  }

  getStoredToken(): string | null {
    return tokenStorage.getToken();
  }

  getStoredRefreshToken(): string | null {
    return tokenStorage.getRefreshToken();
  }

  clearStoredToken(): void {
    tokenStorage.clearTokens();
  }

  /** Dev-only "log in as this user" — see worker/routes/users.ts /:id/impersonate. */
  async impersonate(targetUserId: string | number, targetLabel: string): Promise<void> {
    const response = await this.apiClient.post(`/users/${targetUserId}/impersonate`);
    const { token, refreshToken, expiresIn } = response.data.data;
    beginImpersonation(tokenStorage, { token, refreshToken: refreshToken || '', expiresIn }, targetLabel);
  }

  /** Restore the admin session stashed before impersonate(). */
  exitImpersonation(): boolean {
    return endImpersonation(tokenStorage);
  }

  // Set logout flag to prevent auto-login
  setLogoutFlag(): void {
    tokenStorage.setLogoutFlag();
  }

  // Check if user explicitly logged out
  hasLogoutFlag(): boolean {
    return tokenStorage.hasLogoutFlag();
  }

  // Clear logout flag (called after successful login)
  clearLogoutFlag(): void {
    tokenStorage.clearLogoutFlag();
  }

  // Check if user is authenticated (has valid token)
  isAuthenticated(): boolean {
    return tokenStorage.isTokenValid();
  }

  // Get current user from token
  getCurrentUserFromToken(): User | null {
    return tokenStorage.getUserFromToken();
  }

  // Self-service display preference override (Settings > System Config's
  // per-user override — see worker/routes/auth.ts's PUT /preferences). `null`
  // for a field clears that override back to the tenant default.
  async updatePreferences(updates: Partial<Pick<User, 'timezone' | 'date_format' | 'time_format' | 'default_page_size'>>): Promise<User> {
    try {
      const response: AxiosResponse<{ success: boolean; data: User }> = await this.apiClient.put('/auth/preferences', updates);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to update preferences';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Change password
  async changePassword(currentPassword: string, newPassword: string, confirmPassword: string): Promise<{ message: string }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string }> = await this.apiClient.post('/auth/change-password', {
        currentPassword,
        newPassword,
        confirmPassword
      });
      return { message: response.data.message };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Password change failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Forgot password - request password reset link
  async forgotPassword(email: string, turnstileToken?: string): Promise<{ message: string }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string }> = await this.apiClient.post('/auth/forgot-password', {
        email, turnstileToken
      });
      return { message: response.data.message };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Password reset request failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Reset password with token
  async resetPassword(token: string, newPassword: string, confirmPassword: string, turnstileToken?: string): Promise<{ message: string }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string }> = await this.apiClient.post('/auth/reset-password', {
        token,
        newPassword,
        confirmPassword,
        turnstileToken
      });
      return { message: response.data.message };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Password reset failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Setup 2FA
  async setup2FA(method: string, phoneNumber?: string): Promise<{ secret?: string; qr_code?: string; backup_codes?: any[] }> {
    try {
      const payload: any = { method };
      if (phoneNumber) {
        payload.phone_number = phoneNumber;
      }
      const response: AxiosResponse<{ success: boolean; data: any }> = await this.apiClient.post('/auth/2fa/setup', payload);
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || '2FA setup failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Verify 2FA setup
  async verify2FASetup(method: string, code: string): Promise<{ message: string; backup_codes?: any[] }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string; data?: any }> = await this.apiClient.post('/auth/2fa/verify-setup', {
        method,
        code
      });
      return {
        message: response.data.message,
        backup_codes: response.data.data?.backup_codes
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || '2FA verification failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Verify 2FA during login
  async verify2FA(sessionToken: string, code: string): Promise<AuthResponse> {
    try {
      const response: AxiosResponse<{ success: boolean; data: AuthResponse }> = await this.apiClient.post('/auth/verify-2fa', {
        session_token: sessionToken,
        code
      });
      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || '2FA verification failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Disable 2FA
  async disable2FA(method: string, password: string): Promise<{ message: string }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string }> = await this.apiClient.post('/auth/2fa/disable', {
        method,
        password
      });
      return { message: response.data.message };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || '2FA disable failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Get 2FA methods
  async get2FAMethods(): Promise<any[]> {
    try {
      const response: AxiosResponse<{ success: boolean; data: { methods: any[] } }> = await this.apiClient.get('/auth/2fa/methods');
      return response.data.data.methods;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to fetch 2FA methods';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Regenerate backup codes
  async regenerateBackupCodes(password: string): Promise<{ backup_codes: any[] }> {
    try {
      const response: AxiosResponse<{ success: boolean; data: { backup_codes: any[] } }> = await this.apiClient.post('/auth/2fa/regenerate-backup-codes', {
        password
      });
      return { backup_codes: response.data.data.backup_codes };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Failed to regenerate backup codes';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }

  // Admin reset user password
  async adminResetPassword(userId: number): Promise<{ message: string }> {
    try {
      const response: AxiosResponse<{ success: boolean; message: string }> = await this.apiClient.post(`/users/${userId}/reset-password`);
      return { message: response.data.message };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const message = error.response?.data?.message || 'Admin password reset failed';
        throw new Error(message);
      }
      throw new Error('Network error occurred');
    }
  }
}

// Export singleton instance
export const authService = new AuthService();
export default authService;