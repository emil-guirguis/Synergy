import React from 'react';
import { Toast } from '../common';
import { FormField } from '../formfield/FormField';
import { FormActions } from '../formactions/FormActions';
import './SettingsForm.css';

export interface OrgInfoFormProps {
  values: any;
  onChange: (field: string, value: any) => void;
  onSubmit: () => void;
  onCancel: () => void;
  loading?: boolean;
  error?: string | null;
}

/** Base "basic settings" org-info form: name, address, contact — shared by every app's Settings page. */
const OrgInfoForm: React.FC<OrgInfoFormProps> = ({ values, onChange, onSubmit, onCancel, loading, error }) => {
  const handleFieldChange = (field: string, value: any) => {
    onChange(field, value);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit();
  };

  return (
    <form className="settings-form" onSubmit={handleSubmit}>
      {error && <Toast message={error} type="error" />}

      <div className="settings-form__fields">
        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="name"
              label="Company Name"
              type="text"
              placeholder="Enter company name"
              value={values.name || ''}
              required
              disabled={loading}
              onChange={(e: any) => handleFieldChange('name', e.target.value)}
              onBlur={() => {}}
            />
          </div>
        </div>

        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="address.street"
              label="Address Line 1"
              type="text"
              placeholder="Enter street address"
              value={values.address?.street || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.street', e.target.value)}
              onBlur={() => {}}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="address.street2"
              label="Address Line 2"
              type="text"
              placeholder="Enter address line 2"
              value={values.address?.street2 || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.street2', e.target.value)}
              onBlur={() => {}}
            />
          </div>
        </div>

        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="address.city"
              label="City"
              type="text"
              placeholder="Enter city"
              value={values.address?.city || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.city', e.target.value)}
              onBlur={() => {}}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="address.state"
              label="State"
              type="text"
              placeholder="Enter state"
              value={values.address?.state || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.state', e.target.value)}
              onBlur={() => {}}
            />
          </div>
        </div>

        <div className="settings-form__row">
          <div className="settings-form__field">
            <FormField
              name="address.zip"
              label="Zip Code"
              type="text"
              placeholder="Enter zip code"
              value={values.address?.zip || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.zip', e.target.value)}
              onBlur={() => {}}
            />
          </div>
          <div className="settings-form__field">
            <FormField
              name="address.country"
              label="Country"
              type="country"
              placeholder="Select a country"
              value={values.address?.country || ''}
              required
              disabled={loading}
              onChange={(e: any) => handleFieldChange('address.country', e.target.value)}
              onBlur={() => {}}
            />
          </div>
        </div>

        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="contactInfo.email"
              label="Contact Email"
              type="email"
              placeholder="contact@example.com"
              value={values.contactInfo?.email || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('contactInfo.email', e.target.value)}
              onBlur={() => {}}
            />
          </div>
        </div>

        <div className="settings-form__row settings-form__row--full">
          <div className="settings-form__field">
            <FormField
              name="contactInfo.url"
              label="Website URL"
              type="url"
              placeholder="https://example.com"
              value={values.contactInfo?.url || ''}
              disabled={loading}
              onChange={(e: any) => handleFieldChange('contactInfo.url', e.target.value)}
              onBlur={() => {}}
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

export default OrgInfoForm;
