import React from 'react';
import { FormField } from '../formfield/FormField';
import { FormActions } from '../formactions/FormActions';
import { TIMEZONE_OPTIONS, CURRENCY_OPTIONS, LANGUAGE_OPTIONS } from '../formfield/fieldOptions';
import './SettingsForm.css';

export interface SystemConfigFormProps {
  values: any;
  onChange: (field: string, value: any) => void;
  onSubmit: () => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

/** Base "basic settings" system-config form: timezone/date/time/currency/language/page size. */
const SystemConfigForm: React.FC<SystemConfigFormProps> = ({ values, onChange, onSubmit, onCancel, loading, error }) => {
  return (
    <form className="settings-form" onSubmit={e => { e.preventDefault(); onSubmit(); }}>
      {error && <div className="settings-form__error">{error}</div>}
      <div className="settings-form__fields">
        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="timezone"
              type="select"
              searchable
              label="Timezone"
              value={values.timezone || ''}
              options={TIMEZONE_OPTIONS}
              onChange={(e: any) => onChange('timezone', e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="dateFormat"
              type="text"
              label="Date Format"
              value={values.dateFormat || ''}
              onChange={(e: any) => onChange('dateFormat', e.target.value)}
              disabled={loading}
              placeholder="e.g. MM/DD/YYYY"
            />
          </div>
        </div>
        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="timeFormat"
              type="select"
              label="Time Format"
              value={values.timeFormat || '12h'}
              onChange={(e: any) => onChange('timeFormat', e.target.value)}
              disabled={loading}
              options={[
                { value: '12h', label: '12-hour' },
                { value: '24h', label: '24-hour' },
              ]}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="currency"
              type="select"
              searchable
              label="Currency"
              value={values.currency || ''}
              options={CURRENCY_OPTIONS}
              onChange={(e: any) => onChange('currency', e.target.value)}
              disabled={loading}
            />
          </div>
        </div>
        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="language"
              type="select"
              searchable
              label="Language"
              value={values.language || ''}
              options={LANGUAGE_OPTIONS}
              onChange={(e: any) => onChange('language', e.target.value)}
              disabled={loading}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="defaultPageSize"
              type="number"
              label="Default Page Size"
              value={values.defaultPageSize ?? 20}
              onChange={(e: any) => onChange('defaultPageSize', Number(e.target.value))}
              disabled={loading}
              min={1}
              max={100}
              placeholder="20"
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

export default SystemConfigForm;
