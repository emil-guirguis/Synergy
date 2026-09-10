import React from 'react';
import type { ColumnDefinition } from '../../types/ui';
import type { FilterDefinition, StatDefinition, BulkActionConfig, ExportConfig } from '@meterit/framework-frontend/components/list/types/list';
import {
  createExportAction,
} from '../../config/listHelpers';
import type { Location } from '../../types/entities';

// ============================================================================
// LIST CONFIGURATION - AUTO-GENERATED FROM SCHEMA
// ============================================================================

/**
 * Column definitions for location list - auto-generated from schema
 * Only includes fields marked with showOn: ['list'] in LocationWithSchema
 */
export const locationColumns: ColumnDefinition<Location>[] = [
  {
    key: 'name' as keyof Location,
    label: 'Name',
    sortable: true,
  },
  {
    key: 'type' as keyof Location,
    label: 'Type',
    sortable: true,
  },
  {
    key: 'active' as keyof Location,
    label: 'Active',
    sortable: true,
    render: (value) => {
      const isActive = value as boolean;
      return React.createElement('span', 
        { 
          className: `status-indicator status-indicator--${isActive ? 'active' : 'inactive'}`,
          title: isActive ? 'Active' : 'Inactive'
        },
        React.createElement('span', { className: 'status-indicator__circle' })
      );
    },
  },
];

/**
 * Filter definitions for location list
 */
export const locationFilters: FilterDefinition[] = [
  {
    key: 'type',
    label: 'Type',
    type: 'select',
    options: [
      { label: 'Warehouse', value: 'Warehouse' },
      { label: 'Apartment', value: 'Apartment' },
      { label: 'Office', value: 'Office' },
      { label: 'Retail', value: 'Retail' },
      { label: 'Hotel', value: 'Hotel' },
      { label: 'Building', value: 'Building' },
      { label: 'Other', value: 'Other' },
    ],
    placeholder: 'All Types',
  },
  {
    key: 'active',
    label: 'Status',
    type: 'select',
    options: [
      { label: 'Active', value: 'true' },
      { label: 'Inactive', value: 'false' },
    ],
    placeholder: 'All Statuses',
  },
];

/**
 * Stats definitions for location list
 */
export const locationStats: StatDefinition<Location>[] = [
  {
    label: 'Total Locations',
    value: (items) => Array.isArray(items) ? items.length : 0,
  },
  {
    label: 'Active Locations',
    value: (items) => Array.isArray(items) ? items.filter(l => l.active).length : 0,
  },
];

/**
 * Bulk action configurations for location list
 */
export function createLocationBulkActions(
  _store: any,
  exportFunction: (items: Location[]) => void
): BulkActionConfig<Location>[] {
  return [
    createExportAction<Location>(exportFunction),
  ];
}

/**
 * Export configuration for location list
 */
export const locationExportConfig: ExportConfig<Location> = {
  filename: (date: string) => `locations_export_${date}.csv`,
  headers: [
    'Name',
    'Type',
    'Active',
  ],
  mapRow: (location: Location) => [
    location.name,
    location.type,
    location.active ? 'Yes' : 'No',
  ],
  includeInfo: 'Location export with name, type, and status information',
};
