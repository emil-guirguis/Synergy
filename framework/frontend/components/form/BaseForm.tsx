import React, { useState } from 'react';
// Sidebar intentionally removed from framework-level forms
import type { SidebarSectionProps } from '../sidebar/Sidebar';
import { useSchema } from './utils/schemaLoader';
import { useSchemaForm } from './hooks/useSchemaForm';
import { useFormTabs } from './hooks/useFormTabs';
import { FormTabs } from './FormTabs';
import { ValidationFieldSelect } from '../validationfieldselect/ValidationFieldSelect';
import { FormField } from '../formfield/FormField';
import { TIMEZONE_OPTIONS } from '../formfield/fieldOptions';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RouterOutlinedIcon from '@mui/icons-material/RouterOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import NoteOutlinedIcon from '@mui/icons-material/NoteOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import DeveloperBoardOutlinedIcon from '@mui/icons-material/DeveloperBoardOutlined';
import ScheduleOutlinedIcon from '@mui/icons-material/ScheduleOutlined';
import MailOutlinedIcon from '@mui/icons-material/MailOutlined';
import SecurityOutlinedIcon from '@mui/icons-material/SecurityOutlined';
import DeviceHubOutlinedIcon from '@mui/icons-material/DeviceHubOutlined';
import PeopleOutlinedIcon from '@mui/icons-material/PeopleOutlined';
import AttachMoneyOutlinedIcon from '@mui/icons-material/AttachMoneyOutlined';
import './BaseForm.css';

// Maps section name keywords → icon component
const SECTION_ICONS: Array<[RegExp, React.ElementType]> = [
  [/network|connect|ip|port/i,      RouterOutlinedIcon],
  [/status|active/i,                CheckCircleOutlineIcon],
  [/audit|history|log/i,            HistoryOutlinedIcon],
  [/note|comment|remark|memo/i,     NoteOutlinedIcon],
  [/address|location|place/i,       LocationOnOutlinedIcon],
  [/register/i,                     DeveloperBoardOutlinedIcon],
  [/schedule/i,                     ScheduleOutlinedIcon],
  [/email|mail/i,                   MailOutlinedIcon],
  [/security|auth|permission/i,     SecurityOutlinedIcon],
  [/element|device\s*hub|combined/i,DeviceHubOutlinedIcon],
  [/user|people|contact|member/i,   PeopleOutlinedIcon],
  [/cost|price|billing|financial/i, AttachMoneyOutlinedIcon],
  [/info|general|basic|detail/i,    InfoOutlinedIcon],
];

function getSectionIcon(sectionName: string): React.ReactElement | null {
  for (const [pattern, Icon] of SECTION_ICONS) {
    if (pattern.test(sectionName)) {
      return <Icon sx={{ fontSize: 18, color: 'var(--color-primary, #4f46e5)', opacity: 1 }} />;
    }
  }
  return null;
}

export interface BaseFormProps {
  children?: React.ReactNode;
  onSubmit?: (e: React.FormEvent) => void;
  className?: string;
  sidebarSections?: SidebarSectionProps[];
  sidebarChildren?: React.ReactNode;
  submitLabel?: string;
  cancelLabel?: string;
  onCancel?: () => void;
  isSubmitting?: boolean;
  isDisabled?: boolean;
  // showSidebar?: boolean;
  // Dynamic schema form props
  schemaName?: string;
  entity?: any;
  store?: any;
  onLegacySubmit?: (data: any) => Promise<void>;
  renderCustomField?: (
    fieldName: string,
    fieldDef: any,
    value: any,
    error: string | undefined,
    isDisabled: boolean,
    onChange: (value: any) => void
  ) => React.ReactNode | null;
  fieldSections?: Record<string, string[] | { fields: string[]; maxWidth?: string }>;
  loading?: boolean;
  excludeFields?: string[];
  fieldsToClean?: string[];
  validationDataProvider?: (entityName: string, fieldDef: any) => Promise<Array<{ id: any; label: string }>>;
  showTabs?: boolean;
  onTabChange?: (tabName: string) => void;
  /**
   * Optional callback to render custom content for a specific tab.
   * Called when the active tab's sections produce no field content.
   * Receives the active tab name and should return React content or null.
   */
  renderTabContent?: (tabName: string) => React.ReactNode | null;
  // Form width constraints
  formMaxWidth?: string;
  formMinWidth?: string;
  /**
   * Opaque variant key matched against `visibleFor` on tabs/sections/fields.
   * When omitted, no filtering is applied.
   */
  variant?: string | null;
  /** Optional content rendered on the right side of the tab header bar */
  tabHeaderActions?: React.ReactNode;
  /**
   * Tab names to drop from this form. For a tab whose fields have to stay in the
   * schema because the list's columns and filters are generated from them, while
   * the form itself shows them somewhere else (or not at all).
   */
  hiddenTabs?: string[];
}

/**
 * Base Form Component
 * 
 * Provides a consistent form layout with:
 * - Main content area for form fields
 * - Right sidebar for actions and metadata
 * - Collapsible action sections
 * - Responsive design
 * - Optional dynamic schema-based form rendering
 * 
 * @example
 * ```tsx
 * // Manual form with children
 * <BaseForm
 *   onSubmit={handleSubmit}
 *   className="contact-form"
 * >
 *   Form fields go here
 * </BaseForm>
 * 
 * // Dynamic schema form
 * <BaseForm
 *   schemaName="contact"
 *   entity={contact}
 *   store={contactsStore}
 *   onCancel={handleCancel}
 *   fieldSections={{
 *     'Basic Info': ['name', 'email'],
 *     'Address': ['street', 'city'],
 *   }}
 *   className="contact-form"
 * />
 * ```
 */
export const BaseForm: React.FC<BaseFormProps> = ({
  children,
  onSubmit,
  className = '',
  // sidebarSections and sidebarChildren remain available to callers but framework no longer renders a sidebar
  sidebarSections,
  sidebarChildren,
  onCancel,
  isDisabled = false,
  // Dynamic schema form props
  schemaName,
  entity,
  store,
  onLegacySubmit,
  renderCustomField,
  fieldSections,
  loading = false,
  excludeFields = [],
  fieldsToClean = ['id'],
  validationDataProvider,
  showTabs = true,
  onTabChange,
  renderTabContent,
  // Form width constraints
  formMaxWidth,
  formMinWidth,
  variant,
  tabHeaderActions,
  hiddenTabs,
}) => {
  const formClassName = className ? `base-form ${className}` : 'base-form';
  const [activeTab, setActiveTab] = useState<string>('');

  // Dynamic schema form logic
  const isDynamicForm = !!schemaName;
  const { schema, loading: schemaLoading, error: schemaError } = useSchema(isDynamicForm ? schemaName! : '');

  const { form, errors, setErrors, validateForm } = useSchemaForm({
    schema,
    entity,
    store,
    excludeFields,
    fieldsToClean,
    onLegacySubmit,
    onCancel,
  });

  // Determine the active tab - use state if set, otherwise use first tab from schema
  const effectiveActiveTab = React.useMemo(() => {
    if (activeTab) return activeTab;
    if (schema?.formTabs && schema.formTabs.length > 0) {
      const sortedTabs = [...schema.formTabs]
        .filter((t) => !hiddenTabs?.includes(t.name))
        .sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
      if (sortedTabs.length > 0) return sortedTabs[0].name;
    }
    return '';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema?.formTabs, activeTab, hiddenTabs?.join('|')]);

  // Use formTabs from schema if available, otherwise use provided fieldSections
  const { tabs: allTabs, fieldSections: formTabsFieldSections, tabList } = useFormTabs(
    schema?.formTabs,
    effectiveActiveTab,
    variant,
    hiddenTabs
  );

  // Call onTabChange when effectiveActiveTab changes (including initial load)
  React.useEffect(() => {
    if (effectiveActiveTab && onTabChange) {
      onTabChange(effectiveActiveTab);
    }
  }, [effectiveActiveTab, onTabChange]);


  const handleDynamicSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const { isValid, newErrors } = validateForm();

    if (!isValid || form?.isSubmitting) {
      if (Object.keys(newErrors).length > 0) {
        const firstErrorField = Object.keys(newErrors)[0];
        setTimeout(() => {
          const errorElement = document.getElementById(firstErrorField);
          if (errorElement) {
            errorElement.focus();
            errorElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
          } else {
            // Field not in DOM — likely on an inactive tab; switch to it
            if (schema?.formTabs && schema.formTabs.length > 0) {
              for (const tab of schema.formTabs) {
                if (tab.sections) {
                  for (const section of tab.sections) {
                    if (section.fields && section.fields.some((f: any) => f.name === firstErrorField)) {
                      setActiveTab(tab.name);
                      onTabChange?.(tab.name);
                      setTimeout(() => {
                        const retryElement = document.getElementById(firstErrorField);
                        if (retryElement) {
                          retryElement.focus();
                          retryElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                      }, 100);
                      return;
                    }
                  }
                }
              }
            }
          }
        }, 100);
      }
      return;
    }

    try {
      if (!form) return;
      await form.handleSubmit();
    } catch (error) {
      console.error('[BaseForm] submit error:', error);
    }
  };

  const handleInputChange = (field: string, value: any) => {
    if (!form) return;

    if (form.updateField) {
      form.updateField(field, value);
    } else {
      form.setFormData((prev: any) => ({ ...prev, [field]: value }));
    }

    if (errors[field]) {
      setErrors(prev => {
        const newErrors = { ...prev };
        delete newErrors[field];
        return newErrors;
      });
    }
  };



  const renderField = (fieldName: string, fieldDef: any) => {
    const value = form?.formData?.[fieldName];
    const error = errors[fieldName];
    // `isDisabled` renders the whole form read-only — a viewer who may open a
    // record but not save it (the API rejects their write anyway). Pair it with
    // EntityManagementPage's showSaveButton={false} so there's no dead button.
    const isFormDisabled = loading || isDisabled || !!form?.isSubmitting;

    const customField = renderCustomField?.(fieldName, fieldDef, value, error, isFormDisabled, (val) =>
      handleInputChange(fieldName, val)
    );
    if (customField !== null && customField !== undefined) {
      return customField;
    }

    // Handle validation fields (foreign key relationships)
    if (fieldDef.validate === true && fieldDef.type === 'number') {
      return (
        <ValidationFieldSelect
          key={fieldName}
          fieldName={fieldName}
          fieldDef={fieldDef}
          value={value}
          error={error}
          isDisabled={isFormDisabled}
          onChange={(val) => handleInputChange(fieldName, val)}
          className={className}
          validationDataProvider={validationDataProvider}
        />
      );
    }

    // Determine field type - handle special cases
    let fieldType = fieldDef.type || 'text';
    let fieldOptions = fieldDef.options;

    // Convert boolean to checkbox (which renders as Material Design Switch)
    if (fieldType === 'boolean') {
      fieldType = 'checkbox';
    }

    // Convert enumValues to select with options
    if (fieldDef.enumValues && !fieldOptions) {
      fieldType = 'select';
      fieldOptions = fieldDef.enumValues.map((val: string) => ({
        value: val,
        label: fieldDef.enumLabels?.[val] ?? (val.charAt(0).toUpperCase() + val.slice(1)),
      }));
    }

    // Supply built-in options for special field types
    if (fieldType === 'timezone' && !fieldOptions) {
      fieldOptions = TIMEZONE_OPTIONS;
    }

    // Convert description/notes fields to textarea, but only when maxLength is large enough to warrant it
    const isNoteField = ['notes', 'note', 'comments', 'comment', 'remarks', 'memo'].includes(fieldName.toLowerCase());
    if (isNoteField && (!fieldDef.maxLength || fieldDef.maxLength > 255)) {
      fieldType = 'textarea';
    }

    // Disable autocomplete for address fields to prevent Chrome's save address dialog
    const addressFields = ['street', 'street2', 'city', 'state', 'zip', 'country', 'address'];
    const isAddressField = addressFields.includes(fieldName.toLowerCase());

    // Filter out schema-specific properties that shouldn't be passed to FormField
    const validFormFieldProps = {
      name: isAddressField ? `field_${fieldName}` : fieldName,
      label: fieldDef.label,
      type: fieldType === 'phone' ? 'tel' : fieldType,
      value: fieldType === 'checkbox'
        ? (value || false)
        : fieldType === 'date' && value
          ? String(value).slice(0, 10)
          : fieldType === 'datetime' && value
            ? (() => {
              // Convert UTC ISO datetime to local time for display
              const utcDate = new Date(String(value));
              // Get local time components
              const year = utcDate.getFullYear();
              const month = String(utcDate.getMonth() + 1).padStart(2, '0');
              const day = String(utcDate.getDate()).padStart(2, '0');
              const hours = String(utcDate.getHours()).padStart(2, '0');
              const minutes = String(utcDate.getMinutes()).padStart(2, '0');
              return `${year}-${month}-${day}T${hours}:${minutes}`;
            })()
            : (value || ''),
      error,
      touched: !!error,
      modified: form?.dirtyFields?.has(fieldName),
      help: fieldDef.description,
      required: fieldDef.required,
      disabled: isFormDisabled || !!fieldDef.readOnly || !!fieldDef.disable,
      placeholder: fieldDef.placeholder,
      options: fieldOptions,
      min: fieldDef.min,
      max: fieldDef.max,
      step: fieldDef.step,
      rows: fieldDef.rows || (isNoteField ? 6 : (fieldType === 'textarea' ? 4 : undefined)),
      onChange: (e: any) => {
        if (fieldType === 'checkbox') {
          handleInputChange(fieldName, e.target.checked);
        } else {
          handleInputChange(fieldName, e.target.value);
        }
      },
      onBlur: () => {},
    };

    return (
      <div key={fieldName} className={`${className}__field`} data-field={fieldName} data-type={fieldDef.type || 'text'} data-component={fieldType}>
        <FormField {...validFormFieldProps} />
      </div>
    );
  };

  // Dynamic form loading state
  if (isDynamicForm && schemaLoading) {
    return (
      <div className={formClassName}>
        <div className="form-loading">Loading form schema...</div>
      </div>
    );
  }

  // Dynamic form error state
  if (isDynamicForm && schemaError) {
    return (
      <div className={formClassName}>
        <div className="form-error-banner">
          <span className="error-icon">⚠️</span>
          <span>Failed to load form schema: {schemaError.message}</span>
        </div>
      </div>
    );
  }

  if (isDynamicForm && !schema) {
    return null;
  }

  // Sidebar removed from framework-level forms. Callers can still opt to render their own sidebars

  const handleFormSubmit = isDynamicForm ? handleDynamicSubmit : onSubmit;

  // Determine layout based on schema metadata or fieldSections
  const getLayoutInfo = () => {
    const sectionsToUse = fieldSections || (schema?.formTabs ? formTabsFieldSections : undefined);

    if (!isDynamicForm || !sectionsToUse || Object.keys(sectionsToUse).length === 0) {
      return { gridClass: '', sectionClasses: {} };
    }

    const sectionCount = Object.keys(sectionsToUse).length;
    let gridClass = '';
    const sectionClasses: Record<string, string> = {};

    if (sectionCount === 1) {
      gridClass = 'base-form__main--grid-1';
    } else if (sectionCount === 2) {
      gridClass = 'base-form__main--grid-2';
    } else if (sectionCount >= 3) {
      gridClass = 'base-form__main--grid-3';
    }

    Object.keys(sectionsToUse).forEach(name => { sectionClasses[name] = ''; });

    return { gridClass, sectionClasses };
  };

  const { gridClass, sectionClasses } = getLayoutInfo();

  // Determine if we should use flexbox or grid layout
  const shouldUseFlexbox = () => {
    const sectionsToRender = fieldSections || formTabsFieldSections || {};
    const sections = schema?.formTabs
      ?.flatMap(tab => tab.sections || [])
      .filter(sec => Object.keys(sectionsToRender).includes(sec.name)) || [];
    
    // Use flexbox if any section has flex properties
    return sections.some(sec => 
      sec.flex !== undefined || 
      sec.flexGrow !== undefined || 
      sec.flexShrink !== undefined
    );
  };

  // Only render form content if we have determined the tab structure
  // This prevents fields from flashing before tabs are organized
  const shouldRenderFormContent = !isDynamicForm || (schema && (tabList.length > 0 || !schema.formTabs));

  // Render dynamic form sections
  const useFlexbox = shouldUseFlexbox();
  const containerClass = useFlexbox
    ? 'base-form__sections-container--flex'
    : `base-form__sections-container base-form__sections-container--grid-${Object.keys(fieldSections || formTabsFieldSections || {}).length || 1}`;

  // Renders sections for a single tab. Used both for the active tab and kept-mounted inactive tabs.
  const renderTabSections = (sectionsToRender: Record<string, string[]>, tabName: string, tabUseFlexbox: boolean) => {
    const sectionEntries = Object.entries(sectionsToRender);

    if (sectionEntries.length === 0) return null;

    const allSectionsEmpty = sectionEntries.every(([, fieldNames]) => {
      const visible = (Array.isArray(fieldNames) ? fieldNames : []).filter(f => !excludeFields.includes(f));
      return visible.length === 0;
    });

    if (allSectionsEmpty && renderTabContent && tabName) {
      const tabContent = renderTabContent(tabName);
      if (tabContent) return tabContent;
    }

    return sectionEntries.map(([sectionTitle, fieldNames]) => {
      const visibleFields = (Array.isArray(fieldNames) ? fieldNames : []).filter(f => {
        if (excludeFields.includes(f)) return false;
        const fieldDef = schema?.formFields?.[f] || schema?.entityFields?.[f];
        if (fieldDef?.showIf) {
          const { fieldName: condField, value: condValue } = fieldDef.showIf;
          return form?.formData?.[condField] === condValue;
        }
        return true;
      });

      if (visibleFields.length === 0) return null;

      const sectionData = schema?.formTabs
        ?.flatMap(tab => tab.sections || [])
        .find(sec => sec.name === sectionTitle);
      const sectionMinWidth = sectionData?.minWidth;
      const sectionMaxWidth = sectionData?.maxWidth;
      const sectionFlex = sectionData?.flex;
      const sectionFlexGrow = sectionData?.flexGrow;
      const sectionFlexShrink = sectionData?.flexShrink;
      const sectionHorizontal = !!(sectionData as any)?.horizontal;
      const sectionGridColumn = (sectionData as any)?.gridColumn;
      const sectionGridRow = (sectionData as any)?.gridRow;
      // section({ readOnly: true }) — disable every field in the section without
      // repeating readOnly on each field definition.
      const sectionReadOnly = !!(sectionData as any)?.readOnly;

      const sectionStyle: React.CSSProperties = {};
      if (tabUseFlexbox) {
        if (sectionFlex !== undefined && sectionFlex !== null) sectionStyle.flex = sectionFlex;
        if (sectionFlexGrow !== undefined && sectionFlexGrow !== null) sectionStyle.flexGrow = sectionFlexGrow;
        if (sectionFlexShrink !== undefined && sectionFlexShrink !== null) sectionStyle.flexShrink = sectionFlexShrink;
      }
      if (sectionGridColumn) sectionStyle.gridColumn = sectionGridColumn;
      if (sectionGridRow) sectionStyle.gridRow = sectionGridRow;
      if (sectionMinWidth) sectionStyle.minWidth = sectionMinWidth;
      if (sectionMaxWidth) sectionStyle.maxWidth = sectionMaxWidth;

      return (
        <div
          key={sectionTitle}
          className={`${className}__section${tabUseFlexbox ? ' base-form__section--flex' : ''}`}
          style={Object.keys(sectionStyle).length > 0 ? sectionStyle : undefined}
        >
          <h3 className={`${className}__section-title base-form__section-title`}>
            {getSectionIcon(sectionTitle)}
            {sectionTitle}
            {/address/i.test(sectionTitle) && (() => {
              const d = form?.formData || {};
              const parts = [d.street, d.street2, d.city, d.state, d.zip, d.country].filter(Boolean);
              if (parts.length === 0) return null;
              const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts.join(', '))}`;
              return (
                <a href={url} target="_blank" rel="noopener noreferrer" title="Open in Google Maps" className="base-form__section-title__maps-link">
                  <img src="https://www.google.com/s2/favicons?domain=maps.google.com&sz=16" alt="Google Maps" />
                </a>
              );
            })()}
          </h3>
          {sectionData?.description && (
            <p className="base-form__section-description">{sectionData.description}</p>
          )}
          <div className={sectionHorizontal ? 'base-form__fields-row' : undefined}>
            {visibleFields.map(fieldName => {
              const baseFieldDef = schema?.formFields?.[fieldName] || schema?.entityFields?.[fieldName];
              const fieldDef = baseFieldDef && sectionReadOnly ? { ...baseFieldDef, readOnly: true } : baseFieldDef;
              return fieldDef ? <div key={fieldName} className={sectionHorizontal ? 'base-form__fields-row__item' : undefined}>{renderField(fieldName, fieldDef)}</div> : null;
            })}
          </div>
        </div>
      );
    });
  };

  const formContent = shouldRenderFormContent && isDynamicForm ? (
    schema?.formTabs && tabList.length > 0 ? (
      // Render ALL tabs at once, hiding inactive ones — keeps components mounted across tab switches
      <>
        {tabList.map(tabName => {
          const tabSections = allTabs[tabName]?.sections || {};
          const isActive = tabName === effectiveActiveTab;
          const tabSchema = schema?.formTabs?.find(t => t.name === tabName);
          const tabSchemaSections = tabSchema?.sections || [];
          // Explicit grid from schema (tab({ columns, rows })). Must take precedence over
          // the flex heuristic below: section() defaults flex/flexGrow/flexShrink to 1, so
          // every schema-defined section "has flex props" and would otherwise force the
          // flex container — where each section's gridColumn/gridRow is inert.
          // `columns` is a count (→ repeat(n, 1fr)) or a raw grid-template-columns
          // string (e.g. '2fr 1fr 1fr'); `rows` is a raw grid-template-rows string.
          const tabColumns = (tabSchema as any)?.columns as number | string | null | undefined;
          const tabRows = (tabSchema as any)?.rows as string | null | undefined;
          const tabUseFlexbox = !tabColumns && tabSchemaSections.some(sec =>
            sec.flex !== undefined || sec.flexGrow !== undefined || sec.flexShrink !== undefined
          );
          const tabContainerClass = tabUseFlexbox
            ? 'base-form__sections-container--flex'
            : `base-form__sections-container base-form__sections-container--grid-${Object.keys(tabSections).length || 1}`;
          const tabGridStyle = tabColumns
            ? ({
                '--section-columns': typeof tabColumns === 'number' ? `repeat(${tabColumns}, 1fr)` : tabColumns,
                ...(tabRows ? { '--section-rows': tabRows } : {}),
              } as React.CSSProperties)
            : undefined;

          return (
            <div
              key={tabName}
              className={`${tabContainerClass}${isActive ? '' : ' base-form__tab-container--hidden'}`}
              data-columns={tabColumns || undefined}
              style={tabGridStyle}
            >
              {renderTabSections(tabSections, tabName, tabUseFlexbox)}
            </div>
          );
        })}
      </>
    ) : (
    <div className={containerClass}>
      {/* Render sections from formTabs if available, otherwise use fieldSections prop */}
      {(() => {
        const sectionsToRender = fieldSections || formTabsFieldSections || {};
        const sectionEntries = Object.entries(sectionsToRender);

        if (sectionEntries.length > 0) {
          return renderTabSections(sectionsToRender, effectiveActiveTab, useFlexbox);
        } else {
          // Fallback: render all form fields if no sections are defined
          const allFields = Object.keys(schema?.formFields || {})
            .filter(f => !excludeFields.includes(f));

          return allFields.map(fieldName => {
            const fieldDef = schema?.formFields?.[fieldName];
            return fieldDef ? <div key={fieldName}>{renderField(fieldName, fieldDef)}</div> : null;
          });
        }
      })()}

      {/* Render entity fields that have showOn: ['form'] but are not in fieldSections */}
      {Object.entries(schema?.entityFields || {}).some(([fieldName, fieldDef]) =>
        fieldDef.showOn?.includes('form') &&
        !excludeFields.includes(fieldName) &&
        !Object.values(fieldSections || formTabsFieldSections || {}).flat().includes(fieldName)
      ) && (
        <div className={`${className}__section`}>
          {Object.entries(schema?.entityFields || {}).map(([fieldName, fieldDef]) => {
            if (!fieldDef.showOn?.includes('form') || excludeFields.includes(fieldName)) {
              return null;
            }
            if (Object.values(fieldSections || formTabsFieldSections || {}).flat().includes(fieldName)) {
              return null;
            }
            return <div key={fieldName}>{renderField(fieldName, fieldDef)}</div>;
          })}
        </div>
      )}
    </div>
    )
  ) : (
    children
  );

  return (
    <form
      id={`form-${schemaName || 'base'}`}
      onSubmit={handleFormSubmit}
      className={formClassName}
      autoComplete="off"
      noValidate
      data-form-max-width={formMaxWidth || schema?.formMaxWidth || undefined}
      style={{
        '--form-max-width': formMaxWidth || schema?.formMaxWidth || undefined,
        ...(formMinWidth ? { '--form-min-width': formMinWidth } : {}),
      } as React.CSSProperties}
    >
      {/* Render tabs if using formTabs structure and showTabs is true */}
      {showTabs && schema?.formTabs && tabList.length > 0 && (() => {
        // Compute which tabs have validation errors
        const tabErrors: Record<string, boolean> = {};
        if (Object.keys(errors).length > 0 && schema.formTabs) {
          for (const tab of schema.formTabs) {
            const hasErr = tab.sections?.some(sec =>
              sec.fields?.some((f: any) => errors[f.name])
            );
            if (hasErr) tabErrors[tab.name] = true;
          }
        }
        return (
          <FormTabs
            tabs={allTabs}
            tabList={tabList}
            activeTab={effectiveActiveTab}
            onTabChange={(tabName) => {
              setActiveTab(tabName);
              onTabChange?.(tabName);
            }}
            className={`${className}__tabs`}
            actions={tabHeaderActions}
            tabErrors={tabErrors}
          />
        );
      })()}
      
      <div className="base-form__content">
        <div className={`base-form__main ${gridClass}`}>
          {shouldRenderFormContent ? formContent : null}
        </div>

        {/* Sidebar intentionally removed at framework level */}
      </div>
    </form>
  );
};
        // <Sidebar sections={allSidebarSections}>
        //   {sidebarChildren}
        // </Sidebar>

export default BaseForm;
