import { useState, useMemo, useEffect } from 'react';
import { createFormSchema } from '../utils/formSchema';
import { useEntityFormWithStore } from './useEntityFormWithStore';
import type { ConvertedSchema, BackendFieldDefinition } from '../utils/schemaLoader';

export interface UseSchemaFormOptions {
  schema: ConvertedSchema | null;
  entity: any;
  store: any;
  excludeFields?: string[];
  fieldsToClean?: string[];
  onLegacySubmit?: (data: any) => Promise<void>;
  onCancel?: () => void;
}

/**
 * Extracts all form fields from schema (formTabs primary, formFields fallback).
 * Strips virtual fields (dbField: null).
 */
export function buildAllFormFields(schema: ConvertedSchema | null): Record<string, any> {
  if (!schema) return {};
  const result: Record<string, any> = {};
  schema.formTabs?.forEach((tab: any) =>
    tab.sections?.forEach((sec: any) =>
      sec.fields?.forEach((f: any) => {
        result[f.name] = (schema as any).formFields?.[f.name] ?? f;
      })
    )
  );
  Object.entries((schema as any).formFields ?? {}).forEach(([k, v]) => { result[k] ??= v; });
  Object.keys(result).forEach(k => { if ((result[k] as any)?.dbField === null) delete result[k]; });
  return result;
}

/**
 * Schema-driven form logic hook.
 * Extracted from BaseForm to keep the render component lean.
 * Handles: field mapping, defaults, validation, submit, error toast.
 */
export function useSchemaForm({
  schema,
  entity,
  store,
  excludeFields = [],
  fieldsToClean = ['id'],
  onLegacySubmit,
  onCancel,
}: UseSchemaFormOptions) {
  const [errors, setErrors] = useState<Record<string, string>>({});

  const normalizedEntity = useMemo(() => {
    if (!entity || !schema) return entity;
    const idField = (schema as any).idFieldName;
    if (idField && (entity as any)[idField] !== undefined && (entity as any).id === undefined) {
      return { ...entity, id: (entity as any)[idField] };
    }
    return entity;
  }, [entity, schema]);

  const normalizedStore = useMemo(() => {
    if (!store || !schema) return store;
    const idField = (schema as any).idFieldName;
    const proxy: any = { ...store };

    if (!proxy.createItem) {
      const createFn = proxy.createReport || proxy.create;
      if (createFn) {
        proxy.createItem = async (data: any) => {
          const saved = await createFn(data);
          if (saved && idField && saved[idField] !== undefined && saved.id === undefined) {
            (saved as any).id = saved[idField];
          }
          return saved;
        };
      }
    }

    if (!proxy.updateItem) {
      const updateFn = proxy.updateReport || proxy.update;
      if (updateFn) {
        proxy.updateItem = async (id: string, data: any) => {
          const saved = await updateFn(id, data);
          if (saved && idField && saved[idField] !== undefined && saved.id === undefined) {
            (saved as any).id = saved[idField];
          }
          return saved;
        };
      }
    }

    // Note: do NOT fall back to proxy.updateItem for updateItemInList.
    // updateItem(id, data) takes two args; updateItemInList(entity) takes one.

    return proxy;
  }, [store, schema]);

  const form = useEntityFormWithStore<any, any>({
    entity: schema ? normalizedEntity : undefined,
    store: normalizedStore,
    createMethodName: 'createItem',
    updateMethodName: 'updateItem',

    entityToFormData: (entityData) => {
      if (!schema) return {};
      const fieldsForForm = buildAllFormFields(schema);
      const formSchema = createFormSchema(fieldsForForm);
      const formData = formSchema.fromApi(entityData);

      // Apply schema defaults for null/empty values so selects always show a valid option
      Object.entries(fieldsForForm).forEach(([fieldName, fieldDef]: [string, any]) => {
        const v = formData[fieldName];
        const def = fieldDef.default;
        if ((v === null || v === undefined || v === '') && def !== undefined && def !== null && def !== '') {
          formData[fieldName] = def;
        }
      });

      Object.entries(schema.entityFields || {}).forEach(([fieldName, fieldDef]) => {
        if (fieldDef.showOn?.includes('form') && fieldDef.dbField !== null) {
          formData[fieldName] = entityData[fieldName];
        }
      });

      return formData;
    },

    getDefaultFormData: () => {
      if (!schema) return {};
      const fieldsForDefaults = buildAllFormFields(schema);
      const formSchema = createFormSchema(fieldsForDefaults);
      const defaults = formSchema.getDefaults();

      Object.entries(schema.entityFields || {}).forEach(([fieldName, fieldDef]) => {
        if (fieldDef.showOn?.includes('form') && fieldDef.dbField !== null) {
          defaults[fieldName] = fieldDef.default;
        }
      });

      const now = new Date().toISOString();
      if (fieldsForDefaults['created_at'] && (defaults['created_at'] === null || defaults['created_at'] === undefined)) {
        defaults['created_at'] = now;
      }
      if (fieldsForDefaults['updated_at'] && (defaults['updated_at'] === null || defaults['updated_at'] === undefined)) {
        defaults['updated_at'] = now;
      }
      if (fieldsForDefaults['active'] && (defaults['active'] === null || defaults['active'] === undefined || defaults['active'] === false)) {
        defaults['active'] = true;
      }

      return defaults;
    },

    formDataToEntity: (formData) => {
      if (!schema) return {};
      const allFormFields = buildAllFormFields(schema);
      const cleanFormData = { ...formData };
      Object.keys(formData).forEach(k => { if (!(k in allFormFields)) delete cleanFormData[k]; });
      const formSchema = createFormSchema(allFormFields);
      const apiData = formSchema.toApi(cleanFormData);
      const cleanData = { ...apiData };
      fieldsToClean.forEach(f => { delete cleanData[f]; });
      return cleanData;
    },

    updateStrategy: 'optimistic',

    onSuccess: async (savedEntity) => {
      if (onLegacySubmit) await onLegacySubmit(savedEntity);
      onCancel?.();
    },

    onError: (error, mode) => {
      console.error(`[useSchemaForm] ${mode} failed:`, error);

      let errorMessage = error.message || `Failed to ${mode} record`;
      let apiErrors: any = null;
      let errorDetails = '';

      if ('response' in error) {
        const response = (error as any).response;
        if (response?.data?.errors) {
          apiErrors = response.data.errors;
          errorDetails = Array.isArray(apiErrors)
            ? apiErrors.map((e: any) => typeof e === 'string' ? e : `${e.path}: ${e.msg}`).join('<br/>')
            : JSON.stringify(apiErrors, null, 2);
        }
        if (response?.data?.message) errorMessage = response.data.message;
      }

      const toast = document.createElement('div');
      toast.className = 'form-error-toast';
      toast.innerHTML = `
        <div class="form-error-toast__content">
          <span class="form-error-toast__icon">⚠️</span>
          <div class="form-error-toast__message">
            <strong>${errorMessage}</strong>
            ${errorDetails ? `<div class="form-error-toast__details">${errorDetails}</div>` : ''}
          </div>
          <button class="form-error-toast__close" onclick="this.parentElement.parentElement.remove()">✕</button>
        </div>
      `;
      document.body.appendChild(toast);
      setTimeout(() => { if (toast.parentElement) toast.remove(); }, 7000);
    },
  });

  // Re-initialize form when schema loads or changes.
  // Covers: (1) create mode where entity never transitions from undefined,
  // and (2) edit mode where schema is already cached on first render.
  useEffect(() => {
    if (schema && form) form.resetForm();
  }, [schema]); // eslint-disable-line react-hooks/exhaustive-deps

  function validateForm(): { isValid: boolean; newErrors: Record<string, string> } {
    if (!schema) return { isValid: true, newErrors: {} };
    const newErrors: Record<string, string> = {};

    Object.entries(schema.formFields).forEach(([fieldName, fieldDef]) => {
      if (excludeFields.includes(fieldName)) return;

      const value = form?.formData?.[fieldName];
      const fd = fieldDef as BackendFieldDefinition & { validation?: boolean };

      if (fd.showOn && !fd.showOn.includes('form')) return;

      if (fd.required && (value === undefined || value === null || value === '')) {
        newErrors[fieldName] = `${fd.label} is required`;
        return;
      }

      if ((fd as any).validation === false || (fd as any).validate === true) return;

      if (value !== undefined && value !== null && value !== '') {
        if (fd.type === 'number') {
          const n = typeof value === 'string' ? parseFloat(value) : value;
          if (isNaN(n)) {
            newErrors[fieldName] = `${fd.label} must be a number`;
          } else {
            if (fd.min !== null && fd.min !== undefined && n < fd.min)
              newErrors[fieldName] = `${fd.label} must be at least ${fd.min}`;
            if (fd.max !== null && fd.max !== undefined && n > fd.max)
              newErrors[fieldName] = `${fd.label} must be at most ${fd.max}`;
          }
        }

        if (fd.type === 'string' && typeof value === 'string') {
          if (fd.minLength && value.length < fd.minLength)
            newErrors[fieldName] = `${fd.label} must be at least ${fd.minLength} characters`;
          if (fd.maxLength && value.length > fd.maxLength)
            newErrors[fieldName] = `${fd.label} must be at most ${fd.maxLength} characters`;
          if (fd.pattern && !new RegExp(fd.pattern).test(value))
            newErrors[fieldName] = `${fd.label} format is invalid`;
        }

        if (fd.type === 'email' && typeof value === 'string') {
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))
            newErrors[fieldName] = 'Please enter a valid email address';
        }

        if (fd.enumValues) {
          if (!fd.enumValues.includes(value)) {
            const readable = fd.enumValues.map((v: string) => fd.enumLabels?.[v] ?? v.split('_').filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '));
            newErrors[fieldName] = `${fd.label} must be one of: ${readable.join(', ')}`;
          }
        }
      }
    });

    const isValid = Object.keys(newErrors).length === 0;
    setErrors(newErrors);
    return { isValid, newErrors };
  }

  return { form, errors, setErrors, validateForm };
}
