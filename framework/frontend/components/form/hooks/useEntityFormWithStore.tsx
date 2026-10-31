/**
 * useEntityFormWithStore Hook
 * 
 * Enhanced version of useEntityForm that integrates with entity stores
 * to automatically handle API calls for create/update operations.
 * 
 * By default, uses optimistic updates to immediately reflect changes in the list
 * without requiring a full reload from the API.
 * 
 * This hook combines form state management with store integration,
 * eliminating the need for manual API call wiring in components.
 * 
 * @example
 * ```tsx
 * const ContactManagementPage = () => {
 *   const contacts = useContactsEnhanced();
 *   const [editingContact, setEditingContact] = useState<Contact | null>(null);
 *   
 *   const form = useEntityFormWithStore({
 *     entity: editingContact,
 *     store: contacts,
 *     entityToFormData: (contact) => ({
 *       name: contact.name || '',
 *       email: contact.email || '',
 *     }),
 *     getDefaultFormData: () => ({
 *       name: '',
 *       email: '',
 *     }),
 *     updateStrategy: 'optimistic', // Default - updates list immediately
 *     onSuccess: () => {
 *       setEditingContact(null);
 *     },
 *   });
 *   
 *   return (
 *     <form onSubmit={form.handleSubmit}>
 *       <input {...form.getFieldProps('name')} />
 *       <input {...form.getFieldProps('email')} />
 *       <button type="submit" disabled={form.isSubmitting}>
 *         {form.isEditMode ? 'Update' : 'Create'}
 *       </button>
 *     </form>
 *   );
 * };
 * ```
 */

import { useCallback, useState } from 'react';
import { useEntityForm } from './useEntityForm';
import type { 
  EntityFormWithStoreConfig,
  EntityFormWithStoreReturn,
} from '../types/form';

/**
 * Hook that combines entity form management with store integration
 */
export function useEntityFormWithStore<TEntity extends { id?: string | number }, TFormData>({
  entity,
  store,
  entityToFormData,
  getDefaultFormData,
  onSuccess,
  onError,
  formDataToEntity,
  updateStrategy = 'optimistic',
  refreshAfterSave,
  createMethodName = 'createItem',
  updateMethodName = 'updateItem',
  entityName,
  validateFields,
}: EntityFormWithStoreConfig<TEntity, TFormData>): EntityFormWithStoreReturn<TFormData> {
  
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<Error | null>(null);
  
  // Handle backward compatibility with refreshAfterSave
  // Show deprecation warning if refreshAfterSave is explicitly set
  if (refreshAfterSave !== undefined) {
    console.warn(
      '[useEntityFormWithStore] The "refreshAfterSave" parameter is deprecated. ' +
      'Please use "updateStrategy" instead. ' +
      'Set updateStrategy="reload" for the same behavior as refreshAfterSave=true, ' +
      'or updateStrategy="optimistic" (default) for better performance.'
    );
  }
  
  // Determine effective update strategy
  // If refreshAfterSave is explicitly set, it takes precedence for backward compatibility
  const effectiveUpdateStrategy = refreshAfterSave !== undefined
    ? (refreshAfterSave ? 'reload' : 'optimistic')
    : updateStrategy;
  
  // Use base entity form for state management
  const form = useEntityForm({
    entity,
    entityToFormData,
    getDefaultFormData,
    entityName,
    validateFields,
  });
  
  /**
   * Handle form submission with store integration
   */
  const handleSubmit = useCallback(async (e?: React.FormEvent) => {
    if (e) {
      e.preventDefault();
    }
    
    setIsSubmitting(true);
    setSubmitError(null);

    try {
      const mode = entity ? 'update' : 'create';

      // Transform form data to entity data
      const entityData = formDataToEntity
        ? formDataToEntity(form.formData)
        : (form.formData as unknown as Partial<TEntity>);

      let savedEntity: TEntity;

      if (mode === 'update' && entity?.id) {
        // Update existing entity
        const updateMethod = (store as any)[updateMethodName] || (store as any).update;
        if (!updateMethod) {
          throw new Error(`Store does not have ${updateMethodName} or update method`);
        }
        savedEntity = await updateMethod(String(entity.id), entityData);
      } else {
        // Create new entity
        const createMethod = (store as any)[createMethodName] || (store as any).create;
        if (!createMethod) {
          throw new Error(`Store does not have ${createMethodName} or create method`);
        }
        savedEntity = await createMethod(entityData);
      }
      
      // Validate saved entity has required properties
      if (!savedEntity || !savedEntity.id) {
        console.warn(
          '[useEntityFormWithStore] Invalid saved entity (missing or no id), falling back to reload'
        );
        if ((store as any).fetchItems) {
          await (store as any).fetchItems();
        }
      } else {
        // Update list based on strategy
        if (effectiveUpdateStrategy === 'optimistic') {
          try {
            // For create: createItem already added to list, no need for addItemToList
            // For update: use updateItemInList to update existing item
            if (mode === 'update' && (store as any).updateItemInList) {
              (store as any).updateItemInList(savedEntity);
            } else if (mode === 'create') {
              // createItem already handled adding to list, nothing more needed
            } else {
              // Fallback if methods not available
              console.warn(
                `[useEntityFormWithStore] Store missing optimistic update method for ${mode}, falling back to reload`
              );
              if ((store as any).fetchItems) {
                await (store as any).fetchItems();
              }
            }
          } catch (optimisticError) {
            // Fallback to reload on any optimistic update error
            console.error(
              '[useEntityFormWithStore] Optimistic update failed, falling back to reload:',
              optimisticError
            );
            if ((store as any).fetchItems) {
              await (store as any).fetchItems();
            }
          }
        } else if (effectiveUpdateStrategy === 'reload' && (store as any).fetchItems) {
          await (store as any).fetchItems();
        }
      }
      
      // Call success callback
      if (onSuccess) {
        onSuccess(savedEntity, mode);
      }
      
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      
      // Extract API error details if available
      let apiErrors: any = null;
      
      if (err instanceof Error && 'response' in err) {
        const response = (err as any).response;
        if (response?.data?.errors) {
          apiErrors = response.data.errors;
        }
      }
      
      setSubmitError(err);
      
      // Call error callback with API errors
      if (onError) {
        onError(err, entity ? 'update' : 'create');
      }
      
      console.error('[STORE SUBMIT] Form submission error:', err);
      console.error('[STORE SUBMIT] API errors:', apiErrors);
      throw err; // Re-throw so caller can handle if needed
    } finally {
      setIsSubmitting(false);
    }
  }, [
    entity,
    form.formData,
    store,
    formDataToEntity,
    onSuccess,
    onError,
    effectiveUpdateStrategy,
    createMethodName,
    updateMethodName,
  ]);
  
  return {
    ...form,
    handleSubmit,
    isSubmitting,
    submitError,
  };
}
