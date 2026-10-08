import React, { useState, useCallback } from 'react';
import { FormModal } from '../modal/FormModal';
import { useSchema } from '../form/utils/schemaLoader';
import { ShareMenu, useShareTarget, type SharePerson } from '../share';

export interface EntityManagementPageProps<T = any> {
  title: string;
  moduleIcon?: string;
  modalSize?: 'sm' | 'md' | 'lg' | 'xl';
  /**
   * Schema-driven entities: the entity name passed to GET /api/schema/:entity
   * (same name renderForm's BaseForm uses). When the schema declares a
   * titleField, the edit crumb is auto-derived as "Edit {title} {value}"
   * without an explicit editLabel — e.g. Orders' schema sets
   * titleField: 'ref_number' and every order form header shows its SO#.
   */
  schemaName?: string;
  /**
   * Overrides the auto-generated "Edit {title}" crumb. Pass a string for a
   * static label, or a function to derive it from the entity being edited
   * (e.g. show the record's name in the header). Takes precedence over
   * schemaName's titleField auto-derivation.
   */
  editLabel?: string | ((entity: T) => string);
  /** Overrides auto-generated "New {title}" crumb */
  newLabel?: string;
  saveLabel?: string;
  showSaveButton?: boolean;
  /**
   * Render the list. Receives onEdit and onCreate callbacks.
   * Wire these to your list component's edit/create props. onCreate takes an
   * optional partial entity — pre-fills the new-record form (e.g. a second
   * "create" button that bakes in a fixed field value) without affecting
   * isNew, which is still driven off `selected === null`.
   */
  renderList: (props: { onEdit: (entity: T) => void; onCreate: (initial?: Partial<T>) => void }) => React.ReactNode;
  /**
   * Render the form inside the modal.
   * Called only while the modal is open.
   * Use entity === undefined to detect "new" mode. Note: when opened via
   * onCreate(initial) with partial defaults, `entity` is only AS GOOD AS what
   * the caller passed to onCreate — not necessarily a complete T — even
   * though isNew is still true. Kept typed as T (not Partial<T>) here so
   * every existing renderForm callback keeps compiling unchanged; a form that
   * uses create-with-defaults (see OrderForm) should declare its own looser
   * prop type for the entity it actually receives.
   */
  renderForm: (props: { entity: T | undefined; onCancel: () => void; isNew: boolean }) => React.ReactNode;
  /**
   * Share feature: when set (together with searchPeople/onShare), the form
   * modal gets a Share icon next to Cancel. Omit any of the three to leave
   * Share off for this entity — e.g. one with no deep-link route yet.
   */
  shareUrl?: (entity: T) => string;
  /** Defaults to the same title used for the modal crumb. */
  shareTitle?: string | ((entity: T) => string);
  searchPeople?: (query: string) => Promise<SharePerson[]>;
  onShare?: (params: { recipient: SharePerson; note: string; url: string; title: string }) => Promise<void>;
}

/**
 * Generic list + modal-form page.
 *
 * Encapsulates the select/create/close state and FormModal wiring
 * that was duplicated across every *ManagementPage component.
 *
 * @example
 * ```tsx
 * export const ContactManagementPage = () => (
 *   <EntityManagementPage<Contact>
 *     title="Contact"
 *     moduleIcon="contacts"
 *     renderList={({ onEdit, onCreate }) => (
 *       <ContactList onContactEdit={onEdit} onContactCreate={onCreate} />
 *     )}
 *     renderForm={({ entity, onCancel }) => (
 *       <ContactForm contact={entity} onCancel={onCancel} />
 *     )}
 *   />
 * );
 * ```
 */
export function EntityManagementPage<T = any>({
  title,
  moduleIcon,
  modalSize = 'md',
  schemaName,
  editLabel,
  newLabel,
  saveLabel = 'Save',
  showSaveButton = true,
  renderList,
  renderForm,
  shareUrl,
  shareTitle,
  searchPeople,
  onShare: onShareSubmit,
}: EntityManagementPageProps<T>) {
  const [selected, setSelected] = useState<T | null>(null);
  const [createDefaults, setCreateDefaults] = useState<Partial<T> | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const { shareTarget, openShare, closeShare } = useShareTarget();

  const handleEdit = useCallback((entity: T) => {
    setSelected(entity);
    setCreateDefaults(null);
    setShowForm(true);
    setFormKey(k => k + 1);
  }, []);

  const handleCreate = useCallback((initial?: Partial<T>) => {
    setSelected(null);
    setCreateDefaults(initial ?? null);
    setShowForm(true);
    setFormKey(k => k + 1);
  }, []);

  const handleClose = useCallback(() => {
    setShowForm(false);
    setSelected(null);
    setCreateDefaults(null);
  }, []);

  // Only fetch when schemaName is given and no explicit editLabel override —
  // useSchema's own cache means a sibling BaseForm using the same schemaName
  // costs nothing extra here.
  const { schema } = useSchema(editLabel === undefined && schemaName ? schemaName : '');
  const titleFieldValue = schema?.titleField && selected != null ? (selected as any)[schema.titleField] : null;

  const crumb = selected !== null
    ? (typeof editLabel === 'function'
        ? editLabel(selected)
        : (editLabel ?? (titleFieldValue ? `Edit ${title} ${titleFieldValue}` : `Edit ${title}`)))
    : (newLabel ?? `New ${title}`);

  const canShare = !!(shareUrl && searchPeople && onShareSubmit);
  const handleShareClick = useCallback(() => {
    if (!selected || !shareUrl) return;
    const resolvedTitle = typeof shareTitle === 'function' ? shareTitle(selected) : (shareTitle ?? crumb);
    openShare({ url: shareUrl(selected), title: resolvedTitle });
  }, [selected, shareUrl, shareTitle, crumb, openShare]);

  return (
    <div className="entity-management-page">
      {renderList({ onEdit: handleEdit, onCreate: handleCreate })}

      <FormModal
        isOpen={showForm}
        title={title}
        moduleIcon={moduleIcon}
        crumb={crumb}
        onClose={handleClose}
        showSaveButton={showSaveButton}
        saveLabel={saveLabel}
        size={modalSize}
        onShare={canShare && selected ? handleShareClick : undefined}
      >
        {showForm && (
          <React.Fragment key={formKey}>
            {renderForm({
              // Cast: createDefaults is only ever a Partial<T> (see onCreate's
              // JSDoc above) — renderForm's own type stays T for every other
              // caller's sake, so a partial-defaults form must re-type its own
              // entity prop looser (e.g. OrderForm's order?: Partial<Order>).
              entity: selected ?? (createDefaults as T | null) ?? undefined,
              onCancel: handleClose,
              isNew: selected === null,
            })}
          </React.Fragment>
        )}
      </FormModal>

      {canShare && shareTarget && (
        <ShareMenu
          open={!!shareTarget}
          onClose={closeShare}
          title={shareTarget.title}
          url={shareTarget.url}
          searchPeople={searchPeople!}
          onShare={({ recipient, note }) =>
            onShareSubmit!({ recipient, note, url: shareTarget.url, title: shareTarget.title })
          }
        />
      )}
    </div>
  );
}
