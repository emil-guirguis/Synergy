import { useAuth } from '../contexts/AuthContext';
import { authService } from '../services/authService';

/**
 * Hook that provides validation data for form fields
 * Handles fetching and formatting data for validation dropdowns
 */
export const useValidationDataProvider = () => {
  const auth = useAuth();

  return async (entityName: string, fieldDef: any): Promise<Array<{ id: any; label: string }>> => {

    // Handle location entity
    if (entityName === 'location') {

      // Get locations directly from auth context (backend already filters by tenant)
      let locations = auth.locations || [];

      if (!locations || locations.length === 0) {
        console.warn(`[ValidationDataProvider] No locations found in auth context, attempting to fetch from API`);
        console.warn(`[ValidationDataProvider] Full auth state:`, auth);
        
        // Fallback: fetch locations from API if not in auth context
        try {
          const response = await (authService as any).apiClient.get('/location');
          
          if (response.data.success && response.data.data?.items) {
            locations = response.data.data.items;
          } else {
            console.warn(`[ValidationDataProvider] Location API response missing items`);
            return [];
          }
        } catch (error) {
          console.error(`[ValidationDataProvider] Failed to fetch locations from API:`, error);
          return [];
        }
      }


      // Map locations to options using labelField from fieldDef
      const labelField = fieldDef.validationFields?.[0] || 'name';
      const options = locations.map((location: any) => {
        return {
          id: location.location_id || location.id,
          label: location[labelField] || `${entityName} ${location.location_id || location.id}`,
        };
      });

      return options;
    }

    // Handle device entity
    if (entityName === 'device') {

      try {
        // Use authService's axios client which has proper interceptors and token handling
        // Fetch all devices (override default pagination limit)
        const response = await (authService as any).apiClient.get('/device', { params: { limit: 1000 } });


        // Handle both response formats: { success, data: { items } } and direct array
        let devices = [];
        if (response.data.success && response.data.data?.items) {
          devices = response.data.data.items;
        } else if (Array.isArray(response.data)) {
          devices = response.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          devices = response.data.data;
        }

        if (devices.length === 0) {
          console.warn(`[ValidationDataProvider] No devices found in response`);
          return [];
        }


        // Map devices to options using multiple validation fields
        const validationFields = fieldDef.validationFields || ['manufacturer', 'model_number'];
        
        const options = devices.map((device: any) => {
          
          // Combine multiple fields for the label
          const labelParts = validationFields
            .map((field: string) => device[field])
            .filter((val: any) => val && String(val).trim() !== '');
          
          // Use combined label or fallback to device_id
          const label = labelParts.length > 0 ? labelParts.join(' - ') : `Device ${device.device_id || device.id}`;

          return {
            id: device.device_id || device.id,
            label,
          };
        });

        return options;
      } catch (error) {
        console.error(`[ValidationDataProvider] Error fetching devices:`, error);
        return [];
      }
    }

    // Handle meter_element entity
    if (entityName === 'meter_element') {

      try {
        // Get the meter_id from fieldDef if available (for filtering)
        const meterId = fieldDef.meterId || fieldDef.meter_id;
        
        if (!meterId) {
          console.warn(`[ValidationDataProvider] No meter_id provided for meter_element filtering`);
          return [];
        }

        // Use authService's axios client which has proper interceptors and token handling
        const response = await (authService as any).apiClient.get(`/dashboard/meters/${meterId}/elements`);


        // Handle response format: { success, data: Array }
        let elements = [];
        if (response.data.success && Array.isArray(response.data.data)) {
          elements = response.data.data;
        } else if (Array.isArray(response.data)) {
          elements = response.data;
        } else if (response.data.data && Array.isArray(response.data.data)) {
          elements = response.data.data;
        }

        if (elements.length === 0) {
          console.warn(`[ValidationDataProvider] No meter elements found for meter ${meterId}`);
          return [];
        }


        // Map meter elements to options, combining element and name for display
        const options = elements.map((element: any) => {
          
          // Combine element designation and name for the label
          const label = element.element && element.name 
            ? `${element.element} - ${element.name}`
            : element.name || element.element || `Element ${element.id}`;

          return {
            id: element.id,
            label,
          };
        });

        return options;
      } catch (error) {
        console.error(`[ValidationDataProvider] Error fetching meter elements:`, error);
        return [];
      }
    }

    // Handle sync_server entity (meter → sync server assignment)
    if (entityName === 'sync_server') {
      try {
        const response = await (authService as any).apiClient.get('/sync-servers');

        let servers = [];
        if (response.data.success && Array.isArray(response.data.data)) {
          servers = response.data.data;
        } else if (response.data.data?.items) {
          servers = response.data.data.items;
        } else if (Array.isArray(response.data)) {
          servers = response.data;
        }

        const labelField = fieldDef.validationFields?.[0] || 'name';
        return servers.map((server: any) => ({
          id: server.sync_server_id,
          label: server[labelField] || `Sync Server ${server.sync_server_id}`,
        }));
      } catch (error) {
        console.error(`[ValidationDataProvider] Error fetching sync servers:`, error);
        return [];
      }
    }

    // Add more entity types here as needed
    console.warn(`[ValidationDataProvider] Entity type '${entityName}' not yet supported`);
    return [];
  };
};
