/**
 * Schema Definition Types
 * 
 * TypeScript type definitions for the schema system, including the new
 * hierarchical formTabs structure for organizing fields into tabs and sections.
 */

/**
 * Field type constants
 */
export const FieldTypes = {
  STRING: 'string',
  TEXTAREA: 'textarea',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  EMAIL: 'email',
  PHONE: 'phone',
  COUNTRY: 'country',
  URL: 'url',
  OBJECT: 'object',
  ARRAY: 'array',
  JSON: 'json',
  TIMEZONE: 'timezone',
  CURRENCY: 'currency',
  LANGUAGE: 'language',
} as const;

export type FieldType = typeof FieldTypes[keyof typeof FieldTypes];

/**
 * Relationship type constants
 */
export const RelationshipTypes = {
  BELONGS_TO: 'belongsTo',
  HAS_MANY: 'hasMany',
  HAS_ONE: 'hasOne',
  MANY_TO_MANY: 'manyToMany',
} as const;

export type RelationshipType = typeof RelationshipTypes[keyof typeof RelationshipTypes];

/**
 * Form grouping metadata (legacy structure)
 */
export interface FormGrouping {
  tabName: string;
  sectionName: string;
  tabOrder: number;
  sectionOrder: number;
  fieldOrder: number;
}

/**
 * Field definition
 */
export interface FieldDefinition {
  name?: string | null;
  type: FieldType;
  default?: any;
  required?: boolean;
  readOnly?: boolean;
  label?: string;
  description?: string;
  placeholder?: string;
  dbField?: string | null;
  enumValues?: string[] | null;
  minLength?: number | null;
  maxLength?: number | null;
  min?: number | null;
  max?: number | null;
  pattern?: string | null;
  showOn?: string[] | null;
  formGrouping?: FormGrouping | null;
  validate?: ((value: any, data: any) => string | null) | null;
  validationFields?: string[] | null;
  toApi?: ((value: any) => any) | null;
  fromApi?: ((value: any) => any) | null;
  order?: number | null;
  minWidth?: string | null;
  maxWidth?: string | null;
}

/**
 * Field reference for use in formTabs structure
 */
export interface FieldRef {
  name: string;
  order?: number | null;
}

/**
 * Section definition for use in formTabs structure
 */
export interface Section {
  name: string;
  order?: number | null;
  fields: FieldRef[];
  minWidth?: string | null;
  maxWidth?: string | null;
  flex?: number | null;
  flexGrow?: number | null;
  flexShrink?: number | null;
}

/**
 * Tab definition for use in formTabs structure
 */
export interface Tab {
  name: string;
  order?: number | null;
  sections: Section[];
  sectionOrientation?: 'horizontal' | 'vertical' | null;
}

/**
 * Relationship definition
 */
export interface RelationshipDefinition {
  type: RelationshipType;
  model: string;
  foreignKey: string;
  targetKey?: string;
  through?: string | null;
  autoLoad?: boolean;
  select?: string[] | null;
  as?: string | null;
}

/**
 * Schema definition configuration
 */
export interface SchemaDefinitionConfig {
  entityName: string;
  tableName: string;
  description?: string;
  customListColumns?: Record<string, any>;
  formFields: Record<string, FieldDefinition>;
  formTabs?: Tab[] | null;
  entityFields?: Record<string, FieldDefinition>;
  relationships?: Record<string, RelationshipDefinition>;
  validation?: Record<string, any>;
  /**
   * Name of the field whose value identifies a specific record (e.g. an
   * order's 'ref_number', a contact's 'name'). EntityManagementPage uses it
   * to auto-build the "Edit {title} {value}" form header without every
   * module having to wire its own editLabel.
   */
  titleField?: string | null;
}

/**
 * Schema object returned by defineSchema()
 */
export interface Schema {
  entityName: string;
  tableName: string;
  description: string;
  formFields: Record<string, FieldDefinition>;
  formTabs: Tab[] | null;
  entityFields: Record<string, FieldDefinition>;
  relationships: Record<string, RelationshipDefinition>;
  validation: Record<string, any>;
  titleField: string | null;
  version: string;
  generatedAt: string;
}

/**
 * Schema utilities returned by defineSchema()
 */
export interface SchemaUtilities {
  schema: Schema;
  formFields: Record<string, FieldDefinition>;
  entityFields: Record<string, FieldDefinition>;
  relationships: Record<string, RelationshipDefinition>;
  toJSON(): any;
  getAllFieldNames(): string[];
  getFormFieldNames(): string[];
  getEntityFieldNames(): string[];
  isFormField(fieldName: string): boolean;
  isEntityField(fieldName: string): boolean;
  getField(fieldName: string): FieldDefinition | null;
  validate(data: any): { isValid: boolean; errors: Record<string, string> };
  toDatabase(formData: any): any;
  fromDatabase(dbData: any): any;
  initializeFromData(instance: any, data: any): any;
  getConstructorCode(className: string, dataParamName?: string): string;
}

/**
 * Validation result
 */
export interface ValidationResult {
  isValid: boolean;
  errors: Record<string, string>;
}
