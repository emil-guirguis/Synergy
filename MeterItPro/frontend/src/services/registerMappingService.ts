/**
 * RegisterMappingService
 * 
 * Centralized service for mapping field names to register names.
 * Fetches and caches register mappings from the backend API.
 */

import { apiClient } from './apiClient';

/**
 * Register mapping interface
 */
export interface RegisterMapping {
  fieldName: string;
  registerName: string;
  unit: string;
}

/**
 * Register entity from backend
 */
interface RegisterEntity {
  register_id: number;
  name: string;
  register: number;
  unit: string;
  field_name: string;
}

/**
 * RegisterMappingService class
 */
class RegisterMappingService {
  private mappings: Map<string, RegisterMapping> = new Map();
  private initialized: boolean = false;
  private initializationPromise: Promise<void> | null = null;

  /**
   * Initialize the service by fetching registers from the backend
   */
  async initialize(): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    // Start initialization
    this.initializationPromise = this._performInitialization();
    return this.initializationPromise;
  }

  /**
   * Perform the actual initialization
   */
  private async _performInitialization(): Promise<void> {
    try {
      const response = await apiClient.get('/registers');
      
      if (response.data && Array.isArray(response.data)) {
        // Build the mapping from register entities
        response.data.forEach((register: RegisterEntity) => {
          const mapping: RegisterMapping = {
            fieldName: register.field_name,
            registerName: register.name,
            unit: register.unit,
          };
          this.mappings.set(register.field_name, mapping);
        });
        
        this.initialized = true;
      } else {
        console.warn('⚠️ RegisterMappingService: Invalid response format from API');
        this.initialized = true; // Mark as initialized even if empty
      }
    } catch (error) {
      console.error('❌ RegisterMappingService: Failed to initialize', error);
      this.initialized = true; // Mark as initialized to prevent infinite retries
      // Continue with empty mappings - fallback will be used
    }
  }

  /**
   * Get register name by field name
   * Returns formatted field name as fallback if not found
   */
  getRegisterName(fieldName: string): string {
    const mapping = this.mappings.get(fieldName);
    if (mapping) {
      return mapping.registerName;
    }
    
    // Fallback: format field name
    return this._formatFieldName(fieldName);
  }

  /**
   * Get register unit by field name
   * Returns empty string as fallback if not found
   */
  getRegisterUnit(fieldName: string): string {
    const mapping = this.mappings.get(fieldName);
    if (mapping) {
      return mapping.unit;
    }
    
    // Fallback: return empty string
    return '';
  }

  /**
   * Check if register exists for field name
   */
  hasRegister(fieldName: string): boolean {
    return this.mappings.has(fieldName);
  }

  /**
   * Get all cached mappings
   */
  getAllMappings(): Map<string, RegisterMapping> {
    return new Map(this.mappings);
  }

  /**
   * Format field name to readable format
   * Converts snake_case to Title Case
   */
  private _formatFieldName(fieldName: string): string {
    return fieldName
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset the service (for testing)
   */
  reset(): void {
    this.mappings.clear();
    this.initialized = false;
    this.initializationPromise = null;
  }
}

// Export singleton instance
export const registerMappingService = new RegisterMappingService();

export default registerMappingService;
