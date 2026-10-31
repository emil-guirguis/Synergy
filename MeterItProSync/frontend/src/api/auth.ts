import axios from 'axios';

const CLIENT_API_URL = import.meta.env.VITE_CLIENT_API_URL || 'https://client.meterit.com/api';

export interface LoginCredentials {
  email: string;
  apiKey: string;
}

export interface AuthResponse {
  success: boolean;
  data?: {
    token?: string;
    refreshToken?: string;
    expiresIn?: number;
    user?: {
      users_id: number;
      email: string;
      name: string;
      status: string;
    };
    tenant?: {
      tenant_id: number;
      name: string;
      url?: string;
      street?: string;
      street2?: string;
      city?: string;
      state?: string;
      zip?: string;
      country?: string;
      active?: boolean;
      created_at?: string;
      updated_at?: string;
    };
  };
  error?: string;
}

const authClient = axios.create({
  baseURL: CLIENT_API_URL,
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
});

export const authApi = {
  /**
   * Connect to remote system with email and API key
   * Returns user and tenant information if successful
   */
  login: async (credentials: LoginCredentials): Promise<AuthResponse> => {
    try {

      const response = await authClient.post<AuthResponse>('/sync/connect', {
        email: credentials.email,
        apiKey: credentials.apiKey,
      });


      // Validate response
      if (!response.data.success) {
        console.error('❌ [Auth] Connect failed:', response.data.error);
        return {
          success: false,
          error: response.data.error || 'Connection failed',
        };
      }

      // Check if user has a tenant
      if (!response.data.data?.tenant?.tenant_id) {
        console.error('❌ [Auth] No tenant data in response');
        return {
          success: false,
          error: 'No tenant data received. Please contact support.',
        };
      }


      // The /sync/connect endpoint returns full tenant data including api_key
      return {
        success: true,
        data: {
          user: response.data.data?.user,
          tenant: response.data.data?.tenant,
        },
      };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error('❌ [Auth] Login error:', {
          status: error.response?.status,
          message: error.message,
          code: error.code,
          data: error.response?.data,
        });

        // Handle SSL certificate errors
        if (error.code === 'ERR_CERT_COMMON_NAME_INVALID' || error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
          return {
            success: false,
            error: 'SSL certificate error. Please check the server configuration.',
          };
        }

        // Handle network errors
        if (error.code === 'ERR_NETWORK' || error.message === 'Network Error') {
          return {
            success: false,
            error: 'Network error. Please check your connection and the server URL.',
          };
        }

        if (error.response?.status === 401) {
          return {
            success: false,
            error: 'Invalid email or API key',
          };
        }

        if (error.response?.status === 404) {
          return {
            success: false,
            error: 'User not found',
          };
        }

        return {
          success: false,
          error: error.response?.data?.error || error.message || 'Login failed. Please try again.',
        };
      }

      console.error('❌ [Auth] Unexpected error:', error);
      return {
        success: false,
        error: 'An unexpected error occurred. Please try again.',
      };
    }
  },
};
