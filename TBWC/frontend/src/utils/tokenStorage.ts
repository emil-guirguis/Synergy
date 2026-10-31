/**
 * Token storage utility for managing authentication tokens
 * Handles both localStorage and sessionStorage based on user preference
 */

export interface TokenData {
  token: string;
  refreshToken: string;
  expiresAt: number;
  rememberMe: boolean;
}

class TokenStorage {
  private readonly TOKEN_KEY = 'auth_token';
  private readonly REFRESH_TOKEN_KEY = 'refresh_token';
  private readonly TOKEN_DATA_KEY = 'token_data';
  private readonly EXPIRES_AT_KEY = 'token_expires_at';
  private readonly LOGOUT_FLAG_KEY = 'explicit_logout';
  private rememberMe = false;

  /**
   * Store authentication tokens
   */
  storeTokens(token: string, refreshToken: string, expiresIn: number, rememberMe: boolean = false): void {
    // Clear tokens from BOTH storages first to prevent stale tokens
    // from the other storage being picked up by getToken()/getRefreshToken()
    [localStorage, sessionStorage].forEach(s => {
      s.removeItem(this.TOKEN_KEY);
      s.removeItem(this.REFRESH_TOKEN_KEY);
      s.removeItem(this.TOKEN_DATA_KEY);
      s.removeItem(this.EXPIRES_AT_KEY);
    });

    const storage = rememberMe ? localStorage : sessionStorage;
    const expiresAt = Date.now() + (expiresIn * 1000);

    const tokenData: TokenData = {
      token,
      refreshToken,
      expiresAt,
      rememberMe,
    };

    // Store individual tokens for backward compatibility
    storage.setItem(this.TOKEN_KEY, token);
    storage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);

    // Store complete token data
    storage.setItem(this.TOKEN_DATA_KEY, JSON.stringify(tokenData));

    // Clear logout flag when storing new tokens (user is logging in)
    this.clearLogoutFlag();
  }

  /**
   * Set tokens with expiration
   */
  setTokens(accessToken: string, refreshToken: string, expiresIn: number): void {
    const expiresAt = Date.now() + (expiresIn * 1000);
    
    if (this.rememberMe) {
      localStorage.setItem(this.TOKEN_KEY, accessToken);
      localStorage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);
      localStorage.setItem(this.EXPIRES_AT_KEY, expiresAt.toString());
    } else {
      sessionStorage.setItem(this.TOKEN_KEY, accessToken);
      sessionStorage.setItem(this.REFRESH_TOKEN_KEY, refreshToken);
      sessionStorage.setItem(this.EXPIRES_AT_KEY, expiresAt.toString());
    }
  }

  /**
   * Get stored access token
   */
  getToken(): string | null {
    // Try to get from localStorage first, then sessionStorage
    return localStorage.getItem(this.TOKEN_KEY) || sessionStorage.getItem(this.TOKEN_KEY);
  }

  /**
   * Get stored refresh token
   */
  getRefreshToken(): string | null {
    // Try to get from localStorage first, then sessionStorage
    return localStorage.getItem(this.REFRESH_TOKEN_KEY) || sessionStorage.getItem(this.REFRESH_TOKEN_KEY);
  }

  /**
   * Get complete token data
   */
  getTokenData(): TokenData | null {
    try {
      const data = localStorage.getItem(this.TOKEN_DATA_KEY) || sessionStorage.getItem(this.TOKEN_DATA_KEY);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      console.error('Error parsing token data:', error);
      return null;
    }
  }

  /**
   * Check if token exists and is not expired
   */
  isTokenValid(): boolean {
    const tokenData = this.getTokenData();
    if (!tokenData) return false;

    // Check if token is expired (with 1 minute buffer)
    const now = Date.now();
    const buffer = 60 * 1000; // 1 minute buffer
    return tokenData.expiresAt > (now + buffer);
  }

  /**
   * Check if token is close to expiring (within 5 minutes)
   */
  isTokenExpiringSoon(): boolean {
    const tokenData = this.getTokenData();
    if (!tokenData) return false;

    const now = Date.now();
    const fiveMinutes = 5 * 60 * 1000; // 5 minutes
    return tokenData.expiresAt <= (now + fiveMinutes);
  }

  /**
   * Clear all stored tokens
   */
  clearTokens(): void {
    // Clear from both localStorage and sessionStorage
    [localStorage, sessionStorage].forEach(storage => {
      storage.removeItem(this.TOKEN_KEY);
      storage.removeItem(this.REFRESH_TOKEN_KEY);
      storage.removeItem(this.TOKEN_DATA_KEY);
      storage.removeItem(this.EXPIRES_AT_KEY);
    });
  }

  /**
   * Set logout flag to prevent auto-login after explicit logout (uses sessionStorage - cleared on browser close)
   */
  setLogoutFlag(): void {
    sessionStorage.setItem(this.LOGOUT_FLAG_KEY, 'true');
  }

  /**
   * Clear logout flag (called on successful login)
   */
  clearLogoutFlag(): void {
    sessionStorage.removeItem(this.LOGOUT_FLAG_KEY);
  }

  /**
   * Check if user explicitly logged out
   */
  hasLogoutFlag(): boolean {
    const hasFlag = sessionStorage.getItem(this.LOGOUT_FLAG_KEY) === 'true';
    return hasFlag;
  }

  /**
   * Update tokens (typically after refresh)
   */
  updateTokens(token: string, refreshToken: string, expiresIn: number): void {
    const tokenData = this.getTokenData();
    if (tokenData) {
      this.storeTokens(token, refreshToken, expiresIn, tokenData.rememberMe);
    } else {
      // Fallback to sessionStorage if no existing data
      this.storeTokens(token, refreshToken, expiresIn, false);
    }
  }

  /**
   * Get time until token expires (in milliseconds)
   */
  getTimeUntilExpiry(): number {
    const tokenData = this.getTokenData();
    if (!tokenData) return 0;

    return Math.max(0, tokenData.expiresAt - Date.now());
  }

  /**
   * Check if user chose "Remember Me"
   */
  isRememberMeEnabled(): boolean {
    const tokenData = this.getTokenData();
    return tokenData?.rememberMe || false;
  }

  /**
   * Decode JWT token payload (without verification)
   * Note: This is for client-side use only, server should always verify
   */
  decodeTokenPayload(token?: string): any {
    try {
      const tokenToUse = token || this.getToken();
      if (!tokenToUse) return null;

      const parts = tokenToUse.split('.');
      if (parts.length !== 3) return null;

      const payload = parts[1];
      const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(decoded);
    } catch (error) {
      console.error('Error decoding token payload:', error);
      return null;
    }
  }

  /**
   * Get user data from token payload
   */
  getUserFromToken(): any {
    const payload = this.decodeTokenPayload();
    return payload?.user || payload?.sub || null;
  }
}

// Export singleton instance
export const tokenStorage = new TokenStorage();
export default tokenStorage;