import React from 'react';
import { FormField } from '../formfield/FormField';
import { FormActions } from '../formactions/FormActions';
import { TIMEZONE_OPTIONS, DATE_FORMAT_OPTIONS, PAGE_SIZE_OPTIONS, withCurrentValue } from '../formfield/fieldOptions';
import './SettingsForm.css';

export interface UserPreferencesValues {
  timezone?: string | null;
  date_format?: string | null;
  time_format?: '12h' | '24h' | null;
  default_page_size?: number | null;
}

export interface UserPreferencesFormProps {
  values: UserPreferencesValues;
  onChange: (field: keyof UserPreferencesValues, value: any) => void;
  onSubmit: () => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

/**
 * Self-service override of Settings > System Config's system defaults —
 * one field at a time, for this user only. A blank/empty field means
 * "inherit the system default"; typing a value overrides it.
 */
const UserPreferencesForm: React.FC<UserPreferencesFormProps> = ({ values, onChange, onSubmit, onCancel, loading, error }) => {
  return (
    <form className="settings-form settings-form--compact" onSubmit={(e) => { e.preventDefault(); onSubmit(); }}>
      {error && <div className="settings-form__error">{error}</div>}
      <p className="settings-form__hint">
        Leave a field blank to use the system default from Settings &gt; System Config.
      </p>
      <div className="settings-form__fields">
        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="timezone"
              type="select"
              searchable
              label="Timezone"
              value={values.timezone || ''}
              options={[{ value: '', label: '(system default)' }, ...TIMEZONE_OPTIONS]}
              onChange={(e: any) => onChange('timezone', e.target.value || null)}
              disabled={loading}
            />
          </div>
        </div>
        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="dateFormat"
              type="select"
              label="Date Format"
              value={values.date_format || ''}
              options={[{ value: '', label: '(system default)' }, ...withCurrentValue(DATE_FORMAT_OPTIONS, values.date_format)]}
              onChange={(e: any) => onChange('date_format', e.target.value || null)}
              disabled={loading}
            />
          </div>
        </div>
        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="timeFormat"
              type="select"
              label="Time Format"
              value={values.time_format || ''}
              onChange={(e: any) => onChange('time_format', e.target.value || null)}
              disabled={loading}
              options={[
                { value: '', label: '(system default)' },
                { value: '12h', label: '12-hour' },
                { value: '24h', label: '24-hour' },
              ]}
            />
          </div>
        </div>
        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="defaultPageSize"
              type="select"
              label="Default Page Size"
              value={values.default_page_size ?? ''}
              options={[{ value: '', label: '(system default)' }, ...withCurrentValue(PAGE_SIZE_OPTIONS, values.default_page_size)]}
              onChange={(e: any) => onChange('default_page_size', e.target.value === '' ? null : Number(e.target.value))}
              disabled={loading}
            />
          </div>
        </div>
      </div>
      <FormActions
        onSubmit={onSubmit}
        onCancel={onCancel}
        submitLabel="Save"
        cancelLabel="Cancel"
        isSubmitting={loading}
        isDisabled={loading}
      />
    </form>
  );
};

export default UserPreferencesForm;
