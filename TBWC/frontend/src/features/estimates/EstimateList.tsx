import React, { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useEstimates } from './estimatesStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Estimate } from '../../types/estimate';

interface EstimateListProps {
  onEstimateEdit?: (estimate: Estimate) => void;
  onEstimateCreate?: () => void;
}

/** QuickBooks-synced (or manually drafted — see estimatesStore.ts's create())
 *  estimate list. Admins see, edit, and create every estimate; a rep sees
 *  only their own, read-only (see estimate:read/write grants, migration 056). */
export const EstimateList: React.FC<EstimateListProps> = ({ onEstimateEdit, onEstimateCreate }) => {
  const auth = useAuth();
  const { schema } = useSchema('estimate');
  const [searchParams, setSearchParams] = useSearchParams();
  const estimatesHook = useEstimates();

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Estimate>(schema.formFields, {
      fieldOrder: ['ref_number', 'customer_name', 'sales_rep', 'status', 'txn_date', 'total'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<Estimate, any>({
    entityName: 'estimate',
    entityNamePlural: 'estimates',
    useStore: useEstimates,
    features: {
      allowCreate: true,
      allowEdit: true,
      allowDelete: false,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    permissions: {
      // checkPermission resolves these against the real estimate:write grant
      // (admin only today — migration 056 gives every non-admin role
      // estimate:read 'own' but no write at all). canUpdate below decides the
      // row affordance, not whether the row opens — a rep still opens it,
      // read-only (see EstimateForm), via onView.
      create: Permission.ESTIMATE_CREATE,
      update: Permission.ESTIMATE_UPDATE,
    },
    columns,
    filters,
    onEdit: onEstimateEdit,
    onCreate: onEstimateCreate,
    authContext: auth,
  });

  // AI chat search results link here with ?openId=<qb_estimate_id> (see
  // features/ai/AiChatPage.tsx) — same pattern as OrderList/InvoiceList.
  useEffect(() => {
    const openId = searchParams.get('openId');
    if (!openId || !onEstimateEdit) return;
    estimatesHook
      .fetchItem(openId)
      .then((entity) => entity && onEstimateEdit(entity as unknown as Estimate))
      .catch((err) => console.error('[EstimateList] Failed to open estimate from AI chat link:', err));
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('openId');
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <div className="estimate-list">
      <BaseList
        title="Estimates"
        filters={baseList.renderFilters()}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No estimates found. Run a QuickBooks sync to pull estimates, or create one."
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        onEdit={baseList.canUpdate ? baseList.handleEdit : undefined}
        onView={!baseList.canUpdate ? baseList.handleView : undefined}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
    </div>
  );
};

export default EstimateList;
