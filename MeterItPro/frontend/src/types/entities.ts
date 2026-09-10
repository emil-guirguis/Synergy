// Business Entity Interfaces and Supporting Types

export interface SyncServer {
  sync_server_id: number;
  tenant_id: number;
  location_id: number | null;
  name: string;
  tunnel_url: string;
  timezone: string;
  active: boolean;
  notes: string;
  bootstrap_key: string;
  tunnel_id: string | null;
  provision_status: 'pending' | 'provisioning' | 'active' | 'error';
  provision_error: string | null;
  dns_record_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface SyncServerFormData {
  name: string;
  timezone: string;
  active: boolean;
  notes: string;
  location_id: number | null;
}

// Supporting Types
export interface Address {
  street: string;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}

export interface ContactInfo {
  primaryContact?: string;
  email: string;
  phone: string;
  website?: string;
}

// Location Management
export interface Location {
  id?: string; // Alias for location_id for compatibility
  location_id?: number;
  name: string;
  tenant_id?: string | number;
  type: 'Warehouse' | 'Apartment' | 'Office' | 'Retail' | 'Hotel' | 'Building' | 'Other';
  active: boolean;
  street?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  notes?: string;
  created_at?: Date;
  updated_at?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LocationCreateRequest {
  name: string;
  address: Address;
  contactInfo: ContactInfo;
  type: 'Warehouse' | 'Apartment' | 'Office' | 'Retail' | 'Hotel' | 'Building' | 'Other';
  status?: 'active' | 'inactive' | 'maintenance';
  totalFloors?: number;
  totalUnits?: number;
  yearBuilt?: number;
  squareFootage?: number;
  description?: string;
  notes?: string;
}

export interface LocationUpdateRequest extends Partial<LocationCreateRequest> {
  location_id: number;
}


export interface BusinessInfo {
  taxId?: string;
  industry?: string;
  website?: string;
  preferredPaymentTerms?: string;
  creditLimit?: number;
}

// Meter Management
export interface MeterConfig {
  readingInterval: number; // in minutes
  units: string;
  multiplier: number;
  registers?: number[];
  communicationProtocol?: string;
  baudRate?: number;
  ipAddress?: string;
  port?: number;
}

// Simple meter reading for basic display
export interface MeterReading {
  value: number;
  timestamp: Date;
  unit: string;
  quality: 'good' | 'estimated' | 'questionable';
}

// Detailed meter reading with all electrical parameters
export interface DetailedMeterReading {
  id: string;
  meterId: string;
  ip: string;
  port: number;
  kVARh: number;      // kVAR Hour Net
  kVAh: number;       // kVA Hour Net
  A: number;          // Current (Amperes)
  kWh: number;        // Watt-Hour Meter
  dPF: number;        // Displacement Power Factor
  dPFchannel: number; // Displacement Power Factor Channel
  V: number;          // Volts
  kW: number;         // Watt Demand
  kWpeak: number;     // Demand kW Peak
  timestamp: Date;
  quality: 'good' | 'estimated' | 'questionable';
  createdAt: Date;
  updatedAt: Date;
  
  // Additional optional fields from BACnet agent
  deviceIP?: string;
  source?: string;
  voltage?: number;
  current?: number;
  power?: number;
  energy?: number;
  frequency?: number;
  powerFactor?: number;
  
  // Phase voltage measurements
  phaseAVoltage?: number;
  phaseBVoltage?: number;
  phaseCVoltage?: number;
  
  // Phase current measurements
  phaseACurrent?: number;
  phaseBCurrent?: number;
  phaseCCurrent?: number;
  
  // Phase power measurements
  phaseAPower?: number;
  phaseBPower?: number;
  phaseCPower?: number;
  
  // Line-to-line voltage measurements
  lineToLineVoltageAB?: number;
  lineToLineVoltageBC?: number;
  lineToLineVoltageCA?: number;
  
  // Power measurements
  totalActivePower?: number;
  totalReactivePower?: number;
  totalApparentPower?: number;
  
  // Energy measurements
  totalActiveEnergyWh?: number;
  totalReactiveEnergyVARh?: number;
  totalApparentEnergyVAh?: number;
  importActiveEnergyWh?: number;
  exportActiveEnergyWh?: number;
  importReactiveEnergyVARh?: number;
  exportReactiveEnergyVARh?: number;
  
  // Additional measurements
  frequencyHz?: number;
  temperatureC?: number;
  humidity?: number;
  neutralCurrent?: number;
  groundCurrent?: number;
  
  // Power factor per phase
  phaseAPowerFactor?: number;
  phaseBPowerFactor?: number;
  phaseCPowerFactor?: number;
  
  // Total harmonic distortion
  voltageThd?: number;
  currentThd?: number;
  voltageThdPhaseA?: number;
  voltageThdPhaseB?: number;
  voltageThdPhaseC?: number;
  currentThdPhaseA?: number;
  currentThdPhaseB?: number;
  currentThdPhaseC?: number;
  
  // Individual harmonic measurements
  voltageHarmonic3?: number;
  voltageHarmonic5?: number;
  voltageHarmonic7?: number;
  currentHarmonic3?: number;
  currentHarmonic5?: number;
  currentHarmonic7?: number;
  
  // Demand measurements
  maxDemandKW?: number;
  maxDemandKVAR?: number;
  maxDemandKVA?: number;
  currentDemandKW?: number;
  currentDemandKVAR?: number;
  currentDemandKVA?: number;
  predictedDemandKW?: number;
  
  // Advanced power quality measurements
  voltageUnbalance?: number;
  currentUnbalance?: number;
  voltageFlicker?: number;
  frequencyDeviation?: number;
  
  // Phase sequence and rotation
  phaseSequence?: 'ABC' | 'ACB' | 'BAC' | 'BCA' | 'CAB' | 'CBA';
  phaseRotation?: 'positive' | 'negative';
  
  // Power direction indicators
  powerDirection?: 'import' | 'export';
  reactiveDirection?: 'inductive' | 'capacitive';
  
  // Communication and status fields
  communicationStatus?: 'ok' | 'error' | 'timeout' | 'offline';
  lastCommunication?: Date;
  dataQuality?: 'good' | 'estimated' | 'questionable' | 'bad';
  
  // Register-specific data
  register40001?: number;
  register40002?: number;
  register40003?: number;
  register40004?: number;
  register40005?: number;
  
  // Device information
  deviceModel?: string;
  firmwareVersion?: string;
  serial_number?: string;
  manufacturerCode?: number;
  
  // Meter configuration
  currentTransformerRatio?: number;
  voltageTransformerRatio?: number;
  pulseConstant?: number;
  
  // Time and synchronization
  deviceTime?: Date;
  syncStatus?: 'synchronized' | 'unsynchronized';
  timeSource?: 'internal' | 'ntp' | 'gps';
  
  // Alarm and event information
  alarmStatus?: 'active' | 'inactive';
  eventCounter?: number;
  lastEvent?: string;
}

// Meter Reading Statistics
export interface MeterReadingStats {
  totalReadings: number;
  totalKWh: number;
  totalKVAh: number;
  totalKVARh: number;
  avgPowerFactor: number;
  avgVoltage: number;
  avgCurrent: number;
  maxKWpeak: number;
  uniqueMeters: number;
}

export interface Meter {
  id: string;
  meterId: string; // User-friendly meter identifier
  serial_number: string;
  device: string; // Manufacturer/device name
  model: string; // Model number
  ip: string; // IP address for connection
  portNumber: number; // Port number for connection
  type: 'electric' | 'gas' | 'water' | 'steam' | 'other';
  locationId?: string;
  locationName?: string; // For display purposes
  configuration: MeterConfig;
  lastReading?: MeterReading;
  status: 'active' | 'inactive' | 'maintenance';
  installDate: Date;
  location?: string;
  description?: string;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: {
    id: string;
    name: string;
    email: string;
  };
  updatedBy?: {
    id: string;
    name: string;
    email: string;
  };
}

export interface Device {
  device_id: number;
  type: string;
  manufacturer: string;
  model_number: string;
  description?: string;
  created_at?: Date;
  updated_at?: Date;
} 
export interface MeterCreateRequest {
  meter_id: number;
  serial_number: string;
  device: string;
  model: string;
  ip: string;
  port: number;
  type: 'electric' | 'gas' | 'water' | 'steam' | 'other';
  locationId?: string;
  configuration: MeterConfig;
  installDate: Date;
  location?: string;
  description?: string;
  notes?: string;
}

export interface MeterUpdateRequest extends Partial<MeterCreateRequest> {
  id: string;
  status?: 'active' | 'inactive' | 'maintenance';
}

// Email Template Management
export interface TemplateVariable {
  name: string;
  description: string;
  type: 'text' | 'number' | 'date' | 'boolean';
  required: boolean;
  defaultValue?: any;
}

export interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  content: string;
  variables: TemplateVariable[];
  category: string;
  usageCount: number;
  status: 'active' | 'inactive' | 'draft';
  lastUsed?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailTemplateCreateRequest {
  name: string;
  subject: string;
  content: string;
  variables: TemplateVariable[];
  category: string;
}

export interface EmailTemplateUpdateRequest extends Partial<EmailTemplateCreateRequest> {
  id: string;
  isActive?: boolean;
}

// Company Settings

export interface SystemConfig {
  timezone: string;
  dateFormat: string;
  timeFormat: string;
  currency: string;
  language: string;
  defaultPageSize: number;
  sessionTimeout: number; // in minutes
  enableNotifications: boolean;
  enableEmailAlerts: boolean;
  enableSMSAlerts: boolean;
  maintenanceMode: boolean;
  allowUserRegistration: boolean;
  requireEmailVerification: boolean;
  passwordPolicy: {
    minLength: number;
    requireUppercase: boolean;
    requireLowercase: boolean;
    requireNumbers: boolean;
    requireSpecialChars: boolean;
    maxAge: number; // days
  };
  backupSettings: {
    enabled: boolean;
    frequency: string;
    retentionDays: number;
    includeFiles: boolean;
  };
}

export interface CompanySettings {
  id: string;
  name: string;
  logo?: string;
  address: Address;
  contactInfo: ContactInfo;
  systemConfig: SystemConfig;
  features: {
    userManagement: boolean;
    locationManagement: boolean;
    meterManagement: boolean;
    contactManagement: boolean;
    emailTemplates: boolean;
    reporting: boolean;
    analytics: boolean;
    mobileApp: boolean;
    apiAccess: boolean;
  };
  integrations: {
    emailProvider: string | null;
    smsProvider: string | null;
    paymentProcessor: string | null;
    calendarSync: boolean;
    weatherAPI: boolean;
    mapProvider: string;
  };
  updatedAt: Date;
}

export interface CompanySettingsUpdateRequest {
  name?: string;
  logo?: string;
  address?: Address;
  contactInfo?: ContactInfo;
  systemConfig?: Partial<SystemConfig>;
}

// Entity State Interfaces for CRUD Operations
export interface EntityState<T> {
  items: T[];
  loading: boolean;
  error: string | null;
  total: number;
  currentPage: number;
  pageSize: number;
  filters: Record<string, any>;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface CrudOperations<T, CreateRequest, UpdateRequest> {
  create: (data: CreateRequest) => Promise<T>;
  read: (id: string) => Promise<T>;
  update: (data: UpdateRequest) => Promise<T>;
  delete: (id: string) => Promise<void>;
  list: (params?: ListParams) => Promise<ListResponse<T>>;
}

export interface ListParams {
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  filters?: Record<string, any>;
  search?: string;
}

export interface ListResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// Generic API Response Types
export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
  errors?: string[];
}

export interface ApiError {
  success: false;
  message: string;
  errors?: string[];
  statusCode?: number;
}

// Validation and Form Types
export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
}

// FormState is defined in ui.ts to avoid duplication

// Status and State Constants
export const EntityStatus = {
  ACTIVE: 'active',
  INACTIVE: 'inactive',
  MAINTENANCE: 'maintenance'
} as const;

export type EntityStatus = typeof EntityStatus[keyof typeof EntityStatus];


export const MeterType = {
  ELECTRIC: 'electric',
  GAS: 'gas',
  WATER: 'water',
  STEAM: 'steam',
  OTHER: 'other'
} as const;

export type MeterType = typeof MeterType[keyof typeof MeterType];

export const ReadingQuality = {
  GOOD: 'good',
  ESTIMATED: 'estimated',
  QUESTIONABLE: 'questionable'
} as const;

export type ReadingQuality = typeof ReadingQuality[keyof typeof ReadingQuality];

export const ReadingSource = {
  AUTOMATIC: 'automatic',
  MANUAL: 'manual'
} as const;

export type ReadingSource = typeof ReadingSource[keyof typeof ReadingSource];
