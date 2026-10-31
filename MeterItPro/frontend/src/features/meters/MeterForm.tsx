/**
 * Meter Form
 *
 * Uses the dynamic schema-based BaseForm to render the meter form.
 * All validation, field rendering, and form management is handled by BaseForm.
 * Fields are automatically organized into tabs and sections based on formGrouping metadata.
 */

import React, { useCallback, useState } from 'react';
import { BaseForm, FormContainer } from '@meterit/framework-frontend/components/form';
import { useMetersEnhanced, type Meter } from './metersStore';
import { useValidationDataProvider } from '../../hooks/useValidationDataProvider';
import { ElementsGrid } from './ElementsGrid';
import { CombinedMetersTab } from './CombinedMetersTab';
import './MeterForm.css';

interface MeterFormProps {
  meter?: Meter;
  meterType?: 'physical' | 'virtual' | null;
  onSubmit?: (data: any) => Promise<void>;
  onCancel: () => void;
  loading?: boolean;
}

export const MeterForm: React.FC<MeterFormProps> = ({
  meter,
  meterType,
  onSubmit,
  onCancel,
  loading = false,
}) => {
  const meters = useMetersEnhanced();
  const baseValidationDataProvider = useValidationDataProvider();
  const [isParentSaved, setIsParentSaved] = useState(!!meter?.meter_id);
  // Selected type state for create flow so users can always choose meter type
  // Setter was only called by a removed debug log; the value is still read below.
  const [selectedType] = useState<'physical' | 'virtual' | null>(
    meterType || 'physical'
  );


  // Memoize the provider function to prevent unnecessary re-renders of ValidationFieldSelect
  const validationDataProvider = useCallback(
    (entityName: string, fieldDef: any) => baseValidationDataProvider(entityName, fieldDef),
    [baseValidationDataProvider]
  );

  // Handle parent meter save
  const handleParentSave = useCallback(async () => {
    // This will be called when the first meter is selected in CombinedMetersTab
    // The parent meter should already be saved by this point
    setIsParentSaved(true);
  }, []);

  // Determine if meter is virtual: check the stored value for edit, or selectedType for create
  const isVirtual = meter
    ? (meter.is_virtual === 'virtual' || meter.is_virtual === true)
    : selectedType === 'virtual';
  const determinedMeterType = isVirtual ? 'virtual' : 'physical';
  const meterId = meter?.meter_id || meter?.id;
  // Default installation date to today for create flow
  const todayIsoDate = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const nowIsoDate = new Date().toISOString(); // Full ISO timestamp
  const initialEntity = meter
    ? { ...meter, is_virtual: (meter.is_virtual === true || meter.is_virtual === 'virtual') ? 'virtual' : 'physical' }
    : { installation_date: todayIsoDate, created_at: nowIsoDate, updated_at: nowIsoDate, is_virtual: selectedType || 'physical' };

  return (
    <FormContainer>
      <div className="form-container__content">
        <BaseForm
          schemaName="meter"
          entity={initialEntity}
          store={meters}
          onCancel={onCancel}
          onSubmit={onSubmit}
          className={`meter-form ${isVirtual ? 'meter-form--virtual' : 'meter-form--physical'}`}
          loading={loading}
          validationDataProvider={validationDataProvider}
          showTabs={true}
          variant={determinedMeterType}
          // Keep framework-managed connection fields excluded for virtual meters,
          // but allow the `elements` field to be rendered so `renderCustomField`
          // can provide the custom ElementsGrid / CombinedMetersTab UI.
          excludeFields={isVirtual ? ['serial_number', 'device_id', 'ip', 'port'] : []}
          fieldsToClean={['id', 'elements']}
          renderTabContent={(tabName) => {
            // Render custom content for tabs that have no schema-defined fields
            if (tabName === 'Elements' && !isVirtual) {
              if (!meterId) {
                return <div className="meter-form__placeholder">Save the meter first to manage elements</div>;
              }
              return (
                <div className="meter-form__elements-grid">
                  <ElementsGrid
                    meterId={Number(meterId)}
                    onError={(error) => console.error('ElementsGrid error:', error)}
                  />
                </div>
              );
            }
            if (tabName === 'Combined Meters' && isVirtual) {
              if (!meterId) {
                return <div className="meter-form__placeholder">Save the meter first to manage combined meters</div>;
              }
              return (
                <div className="meter-form__combined-meters-tab">
                  <CombinedMetersTab
                    meterId={meterId}
                    isVirtual={true}
                    isParentSaved={isParentSaved}
                    onParentSave={handleParentSave}
                    onError={(error) => console.error('CombinedMetersTab error:', error)}
                  />
                </div>
              );
            }
            return null;
          }}
          renderCustomField={(fieldName, _fieldDef, value, _error, _isDisabled, _onChange) => {
            // is_virtual field: render as a non-editable bubble/chip
            if (fieldName === 'is_virtual') {
              const isPhysical = value !== 'virtual' && value !== true;
              return (
                <div className={`meter-type-bubble ${isPhysical ? 'meter-type-bubble--physical' : 'meter-type-bubble--virtual'}`}>
                  {isPhysical ? 'Physical' : 'Virtual'}
                </div>
              );
            }

            // When rendering the "elements" field, show ElementsGrid for physical meters or CombinedMetersTab for virtual meters
            if (fieldName === 'elements') {

              if (!meterId) {
                return <div>Save the meter first to manage elements</div>;
              }

              // For virtual meters, show CombinedMetersTab
              if (isVirtual) {
                return (
                  <div className="meter-form__combined-meters-tab">
                    <CombinedMetersTab
                      meterId={meterId}
                      isVirtual={true}
                      isParentSaved={isParentSaved}
                      onParentSave={handleParentSave}
                      onError={(error) => console.error('CombinedMetersTab error:', error)}
                    />
                  </div>
                );
              }

              // For physical meters, show ElementsGrid
              return (
                <div className="meter-form__elements-grid">
                  <ElementsGrid
                    meterId={Number(meterId)}
                    onError={(error) => console.error('ElementsGrid error:', error)}
                  />
                </div>
              );
            }
            // Return null to let BaseForm render the default field
            return null;
          }}
        />
      </div>
    </FormContainer>
  );
};

export default MeterForm;
