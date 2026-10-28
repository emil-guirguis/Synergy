/**
 * Documents grid as a child-row schema — one per parent module, so each
 * module's attachments get their own <key>:read/create/write/delete grants and
 * their own node in Settings > Roles (e.g. Order > Documents), instead of one
 * flat document:* grant covering every module's files.
 *
 * Rows live in the shared public.document table, keyed polymorphically by
 * (entity_type, entity_id) — `parent.foreignKey` is entity_id; the app's
 * documents route still filters by entity_type. Columns mirror the framework
 * DocumentsGrid (frontend/documents/DocumentsGrid.tsx), which uses this
 * schema when given `schemaName` and an identical built-in copy otherwise.
 *
 * Usage (app permissions.ts CHILD_SCHEMAS):
 *   orderGridDocument: documentGridSchema('order'),
 */
import { defineSchema, field, FieldTypes } from './SchemaDefinition';
import { DOC_TYPES } from './documents';

const titleCase = (s: string) => s.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

export function documentGridSchema(parentEntity: string, label = 'Documents') {
  return defineSchema({
    entityName: 'Document',
    tableName: 'document',
    idFieldName: 'document_id',
    description: `Documents attached to a ${parentEntity}`,
    customListColumns: {},
    defaultSortBy: 'created_at desc',
    parent: { entity: parentEntity, foreignKey: 'entity_id', label },

    formFields: {
      description: field({
        name: 'description', order: 1, type: FieldTypes.TEXTAREA, default: '', label: 'Description',
        dbField: 'description', maxLength: 2000, maxWidth: '380px', showOn: ['list', 'form'],
      }),
      // perOptionAccess: which TYPES a role may see is itself per-role, so
      // Settings > Roles renders a checkbox per type under this field (Order >
      // Documents > Type) and the documents route filters rows by the allowed
      // set — see allowedOptions() in permissions.ts. That is what keeps a rep
      // to the customer-facing types (packing slip, invoice, …) on a record
      // whose internal files live in the same table, without hardcoding the
      // list in the route.
      doc_type: field({
        name: 'doc_type', order: 2, type: FieldTypes.SELECT, default: 'other', label: 'Type', dbField: 'doc_type',
        enumValues: [...DOC_TYPES], enumLabels: Object.fromEntries(DOC_TYPES.map((t) => [t, titleCase(t)])),
        perOptionAccess: true, optionsLabel: 'Types', showOn: ['list', 'form'],
      }),
      file_name: field({ name: 'file_name', order: 3, type: FieldTypes.STRING, default: null, readOnly: true, label: 'File', dbField: 'file_name', showOn: ['list', 'form'] }),
      file_size: field({ name: 'file_size', order: 4, type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'Size', dbField: 'file_size', showOn: ['list', 'form'] }),
      created_at: field({ name: 'created_at', order: 5, type: FieldTypes.DATETIME, default: null, readOnly: true, label: 'Uploaded', dbField: 'created_at', showOn: ['list', 'form'] }),
    },
    entityFields: {
      document_id: field({ name: 'document_id', type: FieldTypes.NUMBER, default: null, readOnly: true, label: 'ID', dbField: 'document_id' }),
    },
    validation: {},
  });
}
