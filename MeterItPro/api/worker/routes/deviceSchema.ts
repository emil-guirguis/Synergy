// ===== DEVICE (from DeviceWithSchema.js) =====
// @ts-ignore - CommonJS module
const { defineSchema, field, tab, section, FieldTypes } = require('@meterit/framework-backend/api/base/SchemaDefinition');

export const deviceSchema = defineSchema({
  entityName: 'Device',
  tableName: 'device',
  description: 'Device entity',
  formMaxWidth: '770px',
  // `defaultSortBy` is the property name SchemaDefinition.js actually reads
  // (and serves at GET /api/schema/device) — `defaultSort` here was silently
  // dropped, same mismatch found and fixed in TBWC's orderSchema.ts.
  defaultSortBy: 'manufacturer',

  customListColumns: {},

  formTabs: [
    tab({
      name: 'General',
      order: 1,
      sections: [
        section({
          name: '',
          order: 1,
          flex: 1,
          fields: [
            field({ name: 'manufacturer', order: 1, type: FieldTypes.STRING, default: '', required: true, readOnly: false, label: 'Manufacturer', dbField: 'manufacturer', maxLength: 255, placeholder: 'DENT Instruments', enumValues: ['DENT Instruments','Honeywell','Siemens', 'TBWC, Inc.',], showOn: ['list', 'form'] }),
            field({ name: 'model_number', order: 2, type: FieldTypes.STRING, default: '', required: true, readOnly: false, label: 'Model Number', dbField: 'model_number', maxLength: 255, placeholder: 'Model', showOn: ['list', 'form'] }),
            field({ name: 'description', order: 3, type: FieldTypes.STRING, default: '', required: false, readOnly: false, label: 'Description', dbField: 'description', maxLength: 255, placeholder: 'Device description', showOn: ['list', 'form'] }),
            field({ name: 'type', order: 4, type: FieldTypes.STRING, default: '', required: true, readOnly: false, label: 'Type', dbField: 'type', maxLength: 255, enumValues: ['Electric', 'Gas', 'Water', 'Steam', 'Other'], placeholder: 'Electric', showOn: ['list', 'form'] }),
            field({ name: 'number_of_elements', order: 5, type: FieldTypes.NUMBER, default: 0, required: false, readOnly: false, label: 'Number of Elements', dbField: 'number_of_elements', showOn: ['list', 'form'] }),
            field({ name: 'default_price', order: 6, type: FieldTypes.NUMBER, default: 0, required: false, readOnly: false, label: 'Default Price', dbField: 'default_price', showOn: ['list', 'form'] }),
          ],
        }),
      ],
    }),
    tab({
      name: 'Registers',
      order: 2,
      sections: [
        section({
          name: '',
          order: 1,
          fields: [
            field({ name: 'registers', order: 1, type: FieldTypes.OBJECT, default: null, required: false, readOnly: true, label: 'Registers', showOn: ['form'] }),
          ],
        }),
      ],
    }),
  ],

  entityFields: {
    device_id: field({ name: 'device_id', order: 1, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Id', dbField: 'device_id' }),
  },

  relationships: {},
  validation: {},

  deleteRestrictions: [
    { table: 'meter', fk: 'device_id', label: 'meter' },
    { table: 'device_register', fk: 'device_id', label: 'register assignment' },
  ],
});
