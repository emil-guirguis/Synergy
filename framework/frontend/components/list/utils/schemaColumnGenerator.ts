/**
 * Schema Column Generator
 * 
 * Generates list columns automatically from schema definitions.
 * This eliminates the need to manually define columns in each list component.
 * 
 * Columns are generated based on:
 * - Field type (determines how to render)
 * - Field properties (label, sortable, etc.)
 */

import React from 'react';
import type { ColumnDefinition } from '../types/ui';
import type { FieldDefinition } from '../../form/utils/formSchema';

/**
 * Extended field definition with additional properties from backend schema
 */
interface ExtendedFieldDefinition extends FieldDefinition {
  readOnly?: boolean;
  showOn?: string[];
  enumValues?: string[];
  description?: string;
  placeholder?: string;
  filterable?: boolean;
}

/**
 * Generate column definitions from schema fields
 * 
 * @param fields - Schema form fields
 * @param options - Generation options
 * @returns Array of column definitions
 */
export function generateColumnsFromSchema<T extends Record<string, any>>(
  fields: Record<string, ExtendedFieldDefinition>,
  options?: {
    fieldOrder?: string[];
    responsive?: 'hide-mobile' | 'hide-tablet' | 'always-show';
  }
): ColumnDefinition<T>[] {
  const { fieldOrder = [], responsive = 'hide-mobile' } = options || {};

  // Filter fields that should be shown in list
  const listFields = Object.entries(fields)
    .filter(([, fieldDef]) => {
      // Only include fields with showOn containing 'list'
      const showOn = Array.isArray(fieldDef.showOn) ? fieldDef.showOn : [];
      if (!showOn.includes('list')) {
        return false;
      }

      return true;
    })
    .sort(([nameA], [nameB]) => {
      // Sort by fieldOrder if provided
      const indexA = fieldOrder.indexOf(nameA);
      const indexB = fieldOrder.indexOf(nameB);

      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;

      return 0;
    });

  // Generate columns
  return listFields.map(([fieldName, fieldDef]) => {
    const column: ColumnDefinition<T> = {
      key: fieldName as keyof T,
      label: fieldName === 'active' ? 'Status' : (fieldDef.label || fieldName),
      sortable: true,
      responsive,
      tooltip: fieldDef.description || undefined,
    };

    // Add custom render based on field type
    switch (fieldDef.type) {
      case 'boolean':
        column.render = (_value: any, row: T) => {
          const val = row[fieldName as keyof T];
          if (fieldName === 'active') {
            const label = val ? 'Active' : 'Inactive';
            const mod = val ? 'active' : 'inactive';
            return React.createElement('span', { className: `list-status-badge list-status-badge--${mod}` }, label);
          }
          const label = val ? 'Yes' : 'No';
          const mod = val ? 'true' : 'false';
          return React.createElement('span', { className: `list-status-badge list-status-badge--${mod}` }, label);
        };
        break;

      case 'date':
        column.render = (_value: any, row: T) => {
          const val = row[fieldName as keyof T];
          if (!val) return '';
          const date = new Date(val as any);
          return date.toLocaleDateString();
        };
        break;

      case 'email':
        column.render = (_value: any, row: T) => {
          const val = row[fieldName as keyof T];
          return val ? String(val) : '';
        };
        break;

      case 'phone':
        column.render = (_value: any, row: T) => {
          const val = row[fieldName as keyof T];
          return val ? String(val) : '';
        };
        break;

      default:
        column.render = (_value: any, row: T) => {
          const val = row[fieldName as keyof T];
          return val ? String(val) : '';
        };
    }

    return column;
  });
}

/**
 * Generate filter definitions from schema fields
 * 
 * @param fields - Schema form fields
 * @param options - Generation options
 * @returns Array of filter definitions
 */
export function generateFiltersFromSchema(
  fields: Record<string, ExtendedFieldDefinition>,
  options?: {
    fieldOrder?: string[];
  }
) {
  const { fieldOrder = [] } = options || {};

  // Filter fields that should be filterable
  const filterableFields = Object.entries(fields)
    .filter(([, fieldDef]) => {
      // Only include fields with showOn containing 'list'
      const showOn = Array.isArray(fieldDef.showOn) ? fieldDef.showOn : [];
      if (!showOn.includes('list')) {
        return false;
      }

      // Include enum fields, boolean fields, string fields, or number fields
      if (fieldDef.enumValues || fieldDef.type === 'boolean' || fieldDef.type === 'string' || fieldDef.type === 'number') {
        return true;
      }

      return false;
    })
    .sort(([nameA], [nameB]) => {
      const indexA = fieldOrder.indexOf(nameA);
      const indexB = fieldOrder.indexOf(nameB);

      if (indexA !== -1 && indexB !== -1) {
        return indexA - indexB;
      }
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;

      return 0;
    });

  // Generate filters
  return filterableFields
    .map(([fieldName, fieldDef]) => {
      if (fieldDef.enumValues && fieldDef.enumValues.length > 0) {
        return {
          key: fieldName,
          label: fieldDef.label || fieldName,
          type: 'select' as const,
          options: fieldDef.enumValues.map((val: string) => ({
            label: val,
            value: val,
          })),
          placeholder: `All ${fieldName == 'active' ? 'Statuses' : fieldDef.label || fieldName}`,
        };
      }

      if (fieldDef.type === 'boolean') {
        // Special handling for 'active' field - use Active/Inactive options
        if (fieldName === 'active') {
          return {
            key: fieldName,
            label: fieldDef.label || fieldName,
            type: 'select' as const,
            options: [
              { label: 'All', value: '' },
              { label: 'Active', value: 'true' },
              { label: 'Inactive', value: 'false' },
            ],
          };
        }

        // Standard boolean filter for other fields
        return {
          key: fieldName,
          label: fieldDef.label || fieldName,
          type: 'select' as const,
          options: [
            { label: 'All', value: '' },
            { label: 'Yes', value: 'true' },
            { label: 'No', value: 'false' },
          ],
          placeholder: `All ${fieldDef.label || fieldName}`,
        };
      }

      if (fieldDef.type === 'string' && fieldDef.filterable) {
        // Text filter for string fields marked as filterable
        return {
          key: fieldName,
          label: fieldDef.label || fieldName,
          type: 'text' as const,
          placeholder: `Search ${fieldDef.label || fieldName}...`,
        };
      }

      if (fieldDef.type === 'string') {
        // Text filter for all string fields with showOn: ['list']
        return {
          key: fieldName,
          label: fieldDef.label || fieldName,
          type: 'text' as const,
          placeholder: `Search ${fieldDef.label || fieldName}...`,
        };
      }

      if (fieldDef.type === 'number') {
        // Text filter for number fields (for LIKE search on numeric values)
        return {
          key: fieldName,
          label: fieldDef.label || fieldName,
          type: 'text' as const,
          placeholder: `Search ${fieldDef.label || fieldName}...`,
        };
      }

      return null;
    })
    .filter((f): f is Exclude<typeof f, null> => f !== null);
}
