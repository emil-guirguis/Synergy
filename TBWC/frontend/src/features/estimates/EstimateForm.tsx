import React from 'react';
import { Alert, Box, Button, CircularProgress } from '@mui/material';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import HourglassTopIcon from '@mui/icons-material/HourglassTop';
import { BaseForm, ReferenceSearchField } from '@meterit/framework-frontend/components/form';
import { PickableLineItemsGrid } from '@meterit/framework-frontend/components/datagrid/';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { useEstimatesEnhanced } from './estimatesStore';
import { EstimateLinesGrid } from './EstimateLinesGrid';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { tbwcReferenceSearch } from '../../shared/referenceSearch';
import { useAuth } from '../../hooks/useAuth';
import type { Estimate, EstimateLine } from '../../types/estimate';

interface PendingCustomer {
  list_id: string;
  name: string;
}

// Same rendering as QbSyncDashboardPage's fmtTime — stored UTC, shown in the
// viewer's own local zone with a short zone label.
function fmtSyncTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString('en-US', { timeZoneName: 'short' });
}

interface EstimateFormProps {
  estimate?: Estimate;
  onCancel: () => void;
  loading?: boolean;
}

/**
 * Schema-driven estimate form (GET /api/schema/estimate). Same fresh-fetch-on-
 * open rationale as OrderForm — push_state and the effective memo/lines
 * values can change from outside this screen (another edit, a QB push
 * landing), so this always re-fetches instead of trusting the row the list
 * handed it.
 *
 * Reps (no estimate:write grant) get a read-only viewer: BaseForm's variant
 * filter and isDisabled mirror OrderForm's admin/rep split exactly.
 */
export const EstimateForm: React.FC<EstimateFormProps> = ({ estimate, onCancel, loading = false }) => {
  const estimates = useEstimatesEnhanced();
  const { scopeOf } = useAuth();
  // Driven by the actual estimate:write grant (migrations 042/040), not
  // user.is_admin — today only admin holds it, but an employee role could be
  // granted it without code changing here. Covers the form itself and the
  // Documents tab below (documents.ts's own estimate:write gate is the real
  // enforcement; this just keeps the UI from offering controls that would 403).
  const canWriteEstimates = scopeOf('estimate:write') !== null;
  const variant = canWriteEstimates ? 'admin' : 'rep';
  const readOnly = !canWriteEstimates;
  const [freshEstimate, setFreshEstimate] = React.useState<Estimate | undefined>(estimate?.id ? undefined : estimate);
  const [fetching, setFetching] = React.useState(!!estimate?.id);
  const [pendingLines, setPendingLines] = React.useState<EstimateLine[] | null>(null);
  const [pendingCustomer, setPendingCustomer] = React.useState<PendingCustomer | null>(null);
  const [pushing, setPushing] = React.useState(false);
  const [pushError, setPushError] = React.useState<string | null>(null);
  // Still-local: never reached QuickBooks (a brand-new unsaved record has no
  // txn_id either — freshEstimate is undefined then, so this stays true).
  // Customer/date/lines are only ever editable in this state — see
  // estimateSchema.ts's createOnly and routes/estimates.ts's PUT branch.
  const isLocalDraft = !freshEstimate?.txn_id;

  const reload = React.useCallback((id: string | number) => {
    setFetching(true);
    return estimates.fetchItem(id)
      .then((fresh) => { setFreshEstimate(fresh as Estimate); return fresh as Estimate; })
      .catch(() => { setFreshEstimate(estimate); return undefined; })
      .finally(() => setFetching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimates]);

  React.useEffect(() => {
    if (!estimate?.id) {
      setFreshEstimate(estimate);
      setFetching(false);
      return;
    }
    void reload(estimate.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [estimate?.id]);

  // BaseForm's fieldsToClean strips 'lines' and 'customer_list_id' from every
  // save (same rationale as OrderForm's 'lines' — neither has a dbField
  // BaseForm's generic onChange plumbing would round-trip correctly: lines
  // needs its own add/remove/pick-item state, and customer_list_id is a
  // one-time picker with no visible input of its own once picked). Wrapping
  // create/update to splice the pending picker state back in means a
  // create/PUT only ever carries them when the picker/grid was actually
  // touched this session.
  const applyPending = React.useCallback((data: any) => ({
    ...data,
    ...(pendingLines ? { lines: pendingLines } : {}),
    ...(pendingCustomer ? { customer_list_id: pendingCustomer.list_id, customer_name: pendingCustomer.name } : {}),
  }), [pendingLines, pendingCustomer]);

  const formStore = React.useMemo(() => ({
    ...estimates,
    createItem: (data: any) => estimates.createItem(applyPending(data)),
    updateItem: (id: string, data: any) => estimates.updateItem(id, applyPending(data)),
  }), [estimates, applyPending]);

  const handlePush = async () => {
    if (!freshEstimate?.id) return;
    setPushing(true);
    setPushError(null);
    try {
      await estimates.pushEstimate(freshEstimate.id);
      await reload(freshEstimate.id);
    } catch (e: any) {
      setPushError(e?.message || 'Push failed');
    } finally {
      setPushing(false);
    }
  };

  // Defaults to 'draft' for a brand-new unsaved record (push_state only comes
  // back once there's a saved row to compute it from) — correct either way:
  // nothing's been pushed, and the button stays hidden until freshEstimate.id
  // exists regardless.
  const pushState = freshEstimate?.push_state ?? 'draft';

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {canWriteEstimates && freshEstimate?.id && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 2 }}>
          <Button
            variant="outlined"
            startIcon={pushing ? <CircularProgress size={16} /> : <CloudUploadIcon />}
            disabled={pushing || pushState !== 'draft'}
            onClick={handlePush}
          >
            Push to QuickBooks
          </Button>
          {pushState === 'draft' && (
            <Alert severity="info" sx={{ py: 0 }}>Unsaved changes not yet sent to QuickBooks</Alert>
          )}
          {pushState === 'pending' && (
            <Alert severity="warning" icon={<HourglassTopIcon fontSize="inherit" />} sx={{ py: 0 }}>
              Queued — will be sent to QuickBooks on the next sync
            </Alert>
          )}
          {pushState === 'synced' && (
            <Alert severity="success" sx={{ py: 0 }}>
              Pushed — in sync with QuickBooks
              {fmtSyncTime(freshEstimate.synced_at) && ` (${fmtSyncTime(freshEstimate.synced_at)})`}
            </Alert>
          )}
        </Box>
      )}
      {pushError && <Alert severity="error" sx={{ mb: 2 }}>{pushError}</Alert>}
      <BaseForm
        schemaName="estimate"
        entity={freshEstimate}
        store={formStore}
        onCancel={onCancel}
        className="estimate-form"
        loading={loading}
        showTabs={true}
        variant={variant}
        isDisabled={readOnly}
        fieldsToClean={['id', 'lines', 'documents', 'customer_list_id']}
        renderCustomField={(fieldName, fieldDef, value, error, _isDisabled, onChange) => {
          if (fieldName === 'customer_list_id') {
            // Synced/pushed already — customer_name (a plain schema field)
            // already shows it; nothing to pick anymore.
            if (!isLocalDraft) return null;
            return (
              <ReferenceSearchField
                label={fieldDef?.label ?? 'Customer'}
                config={fieldDef.referenceSearch}
                search={tbwcReferenceSearch}
                disabled={readOnly}
                error={error}
                value={pendingCustomer?.list_id ?? freshEstimate?.customer_list_id ?? null}
                valueLabel={pendingCustomer?.name ?? freshEstimate?.customer_name ?? null}
                onChange={(option) => {
                  setPendingCustomer(option ? { list_id: String(option.value), name: option.label } : null);
                  // Also feeds BaseForm's own formData so its required-field
                  // validation sees a value — applyPending() above is still
                  // what actually goes on the wire either way.
                  onChange(option?.value ?? null);
                }}
              />
            );
          }
          if (fieldName === 'lines') {
            if (isLocalDraft) {
              return (
                <PickableLineItemsGrid
                  lines={pendingLines ?? value ?? []}
                  config={fieldDef.lineItemPicker}
                  disabled={readOnly}
                  search={tbwcReferenceSearch}
                  onChange={setPendingLines}
                />
              );
            }
            return (
              <EstimateLinesGrid
                lines={pendingLines ?? value}
                total={freshEstimate?.total}
                readOnly={readOnly}
                onChange={setPendingLines}
              />
            );
          }
          if (fieldName === 'documents') {
            if (!freshEstimate?.id) {
              return <Alert severity="info">Save the estimate before attaching documents.</Alert>;
            }
            return (
              <DocumentsGrid
                entityType="estimate"
                entityId={freshEstimate.id}
                api={documentsApi}
                storage={documentsStorage}
                classifyDocType={classifyDocTypeForFile}
                readOnly={readOnly}
              />
            );
          }
          return null;
        }}
      />
    </Box>
  );
};

export default EstimateForm;
