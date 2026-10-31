/**
 * Validation Field Select Component
 * 
 * Generic framework component for rendering validation fields (foreign key relationships)
 * Uses FormField with MUI Select for Material Design 3 styling
 * 
 * Configuration is provided via fieldDef.validationSource which specifies:
 * - source: 'auth' | 'api' | 'static'
 * - entityName: name of the entity to fetch (e.g., 'location', 'device')
 * - labelField: field to use as label (e.g., 'name')
 * - valueField: field to use as value (default: 'id')
 */

import React, { useState, useEffect } from 'react';
import { FormField } from '../formfield/FormField';

export interface ValidationFieldSelectProps {
  fieldName: string;
  fieldDef: any;
  value: any;
  error: string | undefined;
  isDisabled: boolean;
  onChange: (value: any) => void;
  className: string;
  validationDataProvider?: (entityName: string, fieldDef: any) => Promise<Array<{ id: any; label: string }>>;
}

export const ValidationFieldSelect: React.FC<ValidationFieldSelectProps> = ({
  fieldName,
  fieldDef,
  value,
  error,
  isDisabled,
  onChange,
  className,
  validationDataProvider,
}) => {
  const [options, setOptions] = useState<Array<{ id: any; label: string }>>([]);
  const [loading, setLoading] = useState(false);

  // Load options from validation data provider
  useEffect(() => {
    
    if (!fieldDef?.validate) {
      return;
    }

    if (!validationDataProvider) {
      console.warn(`[ValidationFieldSelect] ${fieldName}: No validationDataProvider supplied`);
      setOptions([]);
      return;
    }

    const loadOptions = async () => {
      try {
        setLoading(true);

        // Map field names to entity names (e.g., 'location_id' -> 'location')
        const entityName = fieldName.replace('_id', '');


        // Call the provider to get validation data
        const data = await validationDataProvider(entityName, fieldDef);
        
        setOptions(data || []);
      } catch (err) {
        console.error(`[ValidationFieldSelect] ${fieldName}: Error fetching validation data:`, err);
        setOptions([]);
      } finally {
        setLoading(false);
      }
    };

    loadOptions();
  }, [fieldName, fieldDef?.validate, validationDataProvider]);


  // Determine placeholder text
  let placeholderText = `Select ${fieldDef.label}`;
  if (loading) {
    placeholderText = 'Loading...';
  } else if (options.length === 0) {
    placeholderText = `No ${fieldDef.label.toLowerCase()} available`;
  }

  // Convert options to FormField format
  // MUI Select requires string values, so we convert IDs to strings
  const formFieldOptions = options.map((option) => {
    const stringValue = String(option.id);
    return {
      value: stringValue,
      label: option.label,
    };
  });

  // Ensure value is a string for MUI Select comparison
  // Handle null, undefined, 0, and other falsy values properly
  const selectValue = value !== null && value !== undefined ? String(value) : '';

  return (
    <div className={`${className}__field`}>
      <FormField
        name={fieldName}
        label={fieldDef.label}
        type="select"
        value={selectValue}
        error={error}
        touched={!!error}
        help={fieldDef.description}
        required={fieldDef.required}
        disabled={isDisabled || loading}
        placeholder={placeholderText}
        options={formFieldOptions}
        onChange={(e: any) => {
          const rawValue = e.target.value;
          
          // Handle the case where value is the string 'undefined'
          let selectedValue: number | null = null;
          if (rawValue && rawValue !== 'undefined' && rawValue !== '') {
            selectedValue = parseInt(rawValue, 10);
            if (isNaN(selectedValue)) {
              console.warn(`[ValidationFieldSelect] ${fieldName} Failed to parse value:`, rawValue);
              selectedValue = null;
            }
          }
          
          onChange(selectedValue);
        }}
        onBlur={() => {}}
      />
    </div>
  );
};

export default ValidationFieldSelect;
