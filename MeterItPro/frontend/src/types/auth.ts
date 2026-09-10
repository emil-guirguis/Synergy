// Authentication and User Management Types

// Must stay in step with usersSchema.ts enumValues and with ROLE_PERMISSIONS in
// api/worker/routes/auth.ts — the API is what actually enforces access, and an
// unknown role there silently falls back to viewer.
export const UserRole = {
  SUPER_ADMIN: 'superadmin',
  SUPER_SUPPORT: 'supersupport',
  ADMIN_SUPPORT: 'adminsupport',
  ADMIN: 'admin',
  MANAGER: 'manager',
  TECHNICIAN: 'technician',
  VIEWER: 'viewer',
  USER: 'user'
} as const;

export type UserRole = typeof UserRole[keyof typeof UserRole];

export const Permission = {
  // Dashboard Management
  DASHBOARD_READ: 'dashboard:read',
  
  // User Management
  USER_CREATE: 'user:create',
  USER_READ: 'user:read',
  USER_UPDATE: 'user:update',
  USER_DELETE: 'user:delete',
  
  // Location Management
  LOCATION_CREATE: 'location:create',
  LOCATION_READ: 'location:read',
  LOCATION_UPDATE: 'location:update',
  LOCATION_DELETE: 'location:delete',
  
  // Contact Management
  CONTACT_CREATE: 'contact:create',
  CONTACT_READ: 'contact:read',
  CONTACT_UPDATE: 'contact:update',
  CONTACT_DELETE: 'contact:delete',
  
  // Meter Management
  METER_CREATE: 'meter:create',
  METER_READ: 'meter:read',
  METER_UPDATE: 'meter:update',
  METER_DELETE: 'meter:delete',
  
  // Device Management
  DEVICE_READ: 'device:read',
  
  // Settings Management
  SETTINGS_READ: 'settings:read',
  SETTINGS_UPDATE: 'settings:update',
  
  // Email Template Management
  TEMPLATE_CREATE: 'template:create',
  TEMPLATE_READ: 'template:read',
  TEMPLATE_UPDATE: 'template:update',
  TEMPLATE_DELETE: 'template:delete',
  
  // Report Management
  REPORT_CREATE: 'report:create',
  REPORT_READ: 'report:read',
  REPORT_UPDATE: 'report:update',
  REPORT_DELETE: 'report:delete',

  // Notification Rule Management
  NOTIFICATION_RULE_CREATE: 'notification_rule:create',
  NOTIFICATION_RULE_READ: 'notification_rule:read',
  NOTIFICATION_RULE_UPDATE: 'notification_rule:update',
  NOTIFICATION_RULE_DELETE: 'notification_rule:delete'
} as const;

export type Permission = typeof Permission[keyof typeof Permission];

export interface User {
  id?: string; // Alias for users_id for compatibility
  users_id: string;
  email: string;
  name: string;
  client: string;
  role: UserRole;
  permissions: string[]; // Accept any string, not just Permission enum
  active: boolean;
  lastLogin?: Date;
  createdAt: Date;
  updatedAt: Date;
  isAdminView?: boolean;
  adminViewTenantName?: string;
  is_super_admin?: boolean;
  is_support_admin?: boolean;
}

export interface LoginCredentials {
  email: string;
  password: string;
  rememberMe?: boolean;
  turnstileToken?: string;
}

export interface AuthResponse {
  user: User;
  token: string;
  refreshToken: string;
  expiresIn: number;
  locations?: any[]; // Locations for the user's tenant
  requires_2fa?: boolean; // Whether 2FA is required
  session_token?: string; // Temporary session token for 2FA verification
  twofa_method?: 'totp' | 'email_otp' | 'sms_otp'; // The 2FA method to use
}

export interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  locations: any[];
}

export interface AuthContextType extends AuthState {
  login: (credentials: LoginCredentials) => Promise<AuthResponse>;
  logout: () => void;
  refreshToken: () => Promise<void>;
  checkPermission: (permission?: string) => boolean;
  hasRole: (role: UserRole) => boolean;
  getLocationsByTenant: (tenantId: string) => any[];
}

// Role-based permission validation
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.SUPER_ADMIN]: [
    ...Object.values(Permission)
  ],
  [UserRole.ADMIN]: [
    // Full access to all permissions
    ...Object.values(Permission)
  ],
  [UserRole.MANAGER]: [
    // Dashboard access
    Permission.DASHBOARD_READ,

    // User management (limited)
    Permission.USER_CREATE,
    Permission.USER_READ,
    Permission.USER_UPDATE,

    // Full location management
    Permission.LOCATION_CREATE,
    Permission.LOCATION_READ,
    Permission.LOCATION_UPDATE,
    Permission.LOCATION_DELETE,

    // Full contact management
    Permission.CONTACT_CREATE,
    Permission.CONTACT_READ,
    Permission.CONTACT_UPDATE,
    Permission.CONTACT_DELETE,

    // Full meter management
    Permission.METER_CREATE,
    Permission.METER_READ,
    Permission.METER_UPDATE,
    Permission.METER_DELETE,

    // Full device management
    Permission.DEVICE_READ,

    // Settings read/update
    Permission.SETTINGS_READ,
    Permission.SETTINGS_UPDATE,

    // Full template management
    Permission.TEMPLATE_CREATE,
    Permission.TEMPLATE_READ,
    Permission.TEMPLATE_UPDATE,
    Permission.TEMPLATE_DELETE,

    // Full report management
    Permission.REPORT_CREATE,
    Permission.REPORT_READ,
    Permission.REPORT_UPDATE,
    Permission.REPORT_DELETE,

    // Full notification rule management
    Permission.NOTIFICATION_RULE_CREATE,
    Permission.NOTIFICATION_RULE_READ,
    Permission.NOTIFICATION_RULE_UPDATE,
    Permission.NOTIFICATION_RULE_DELETE
  ],
  [UserRole.TECHNICIAN]: [
    // Dashboard access
    Permission.DASHBOARD_READ,

    // Read-only user access
    Permission.USER_READ,

    // Read-only location access
    Permission.LOCATION_READ,

    // Read-only contact access
    Permission.CONTACT_READ,

    // Full meter management
    Permission.METER_CREATE,
    Permission.METER_READ,
    Permission.METER_UPDATE,
    Permission.METER_DELETE,

    // Full device management
    Permission.DEVICE_READ,

    // Read-only settings
    Permission.SETTINGS_READ,

    // Read-only template access
    Permission.TEMPLATE_READ,

    // Full report management
    Permission.REPORT_CREATE,
    Permission.REPORT_READ,
    Permission.REPORT_UPDATE,
    Permission.REPORT_DELETE,

    // Full notification rule management
    Permission.NOTIFICATION_RULE_CREATE,
    Permission.NOTIFICATION_RULE_READ,
    Permission.NOTIFICATION_RULE_UPDATE,
    Permission.NOTIFICATION_RULE_DELETE
  ],
  [UserRole.VIEWER]: [
    // Dashboard access
    Permission.DASHBOARD_READ,

    // Read-only access to most entities
    Permission.USER_READ,
    Permission.LOCATION_READ,
    Permission.CONTACT_READ,
    Permission.METER_READ,
    Permission.DEVICE_READ,
    Permission.SETTINGS_READ,
    Permission.TEMPLATE_READ,

    // Read-only report access
    Permission.REPORT_READ,

    // Read-only notification rule access
    Permission.NOTIFICATION_RULE_READ
  ],
  // Support staff: read-only across a tenant, for triaging tickets. Mirrors
  // SUPPORT_READ_PERMISSIONS in api/worker/routes/auth.ts — no report or
  // notification-rule access there, so none here either.
  [UserRole.SUPER_SUPPORT]: [
    Permission.DASHBOARD_READ,
    Permission.USER_READ,
    Permission.LOCATION_READ,
    Permission.CONTACT_READ,
    Permission.METER_READ,
    Permission.DEVICE_READ,
    Permission.SETTINGS_READ,
    Permission.TEMPLATE_READ
  ],
  [UserRole.ADMIN_SUPPORT]: [
    Permission.DASHBOARD_READ,
    Permission.USER_READ,
    Permission.LOCATION_READ,
    Permission.CONTACT_READ,
    Permission.METER_READ,
    Permission.DEVICE_READ,
    Permission.SETTINGS_READ,
    Permission.TEMPLATE_READ
  ],
  // Plain end user: read-only, and cannot see the user directory.
  [UserRole.USER]: [
    Permission.DASHBOARD_READ,
    Permission.LOCATION_READ,
    Permission.CONTACT_READ,
    Permission.METER_READ,
    Permission.DEVICE_READ,
    Permission.SETTINGS_READ,
    Permission.TEMPLATE_READ
  ]
};

// Export all available permissions for UI components
export const AVAILABLE_PERMISSIONS = Object.entries(Permission).map(([key, value]) => ({
  key,
  value,
  label: key
    .replace(/_/g, ' ')
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, str => str.toUpperCase())
    .trim()
}));

// Validation types
export interface ValidationError {
  field: string;
  message: string;
}

export interface LoginValidation {
  isValid: boolean;
  errors: ValidationError[];
}

// Utility functions for permission checking
export const hasPermission = (user: User | null, permission: Permission): boolean => {
  if (!user) return false;
  return user.permissions.includes(permission);
};

export const hasRole = (user: User | null, role: UserRole): boolean => {
  if (!user) return false;
  return user.role === role;
};

export const validateLoginCredentials = (credentials: LoginCredentials): LoginValidation => {
  const errors: ValidationError[] = [];
  
  if (!credentials.email) {
    errors.push({ field: 'email', message: 'Email is required' });
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.email)) {
    errors.push({ field: 'email', message: 'Please enter a valid email address' });
  }
  
  if (!credentials.password) {
    errors.push({ field: 'password', message: 'Password is required' });
  } else if (credentials.password.length < 4) {
    errors.push({ field: 'password', message: 'Password must be at least 4 characters long' });
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
};