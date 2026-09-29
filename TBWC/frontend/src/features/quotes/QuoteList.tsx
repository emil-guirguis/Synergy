import React, { useMemo } from 'react';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { useQuotesEnhanced } from './quotesStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import type { Quote } from '../../types/quote';

interface QuoteListProps {
  onQuoteEdit?: (quote: Quote) => void;
  onQuoteCreate?: () => void;
}

export const QuoteList: React.FC<QuoteListProps> = ({ onQuoteEdit, onQuoteCreate }) => {
  const auth = useAuth();
  const { schema } = useSchema('quote');

  // Quotes are a rep-facing builder: any approved user may create/edit their own
  // (the Worker enforces owner-or-admin). Override the admin-only checkPermission
  // so the create/edit/delete controls render for reps too.
  const quoteAuth = useMemo(
    () => ({ ...auth, checkPermission: () => true }),
    [auth]
  );

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Quote>(schema.formFields, {
      fieldOrder: ['quote_number', 'project_name', 'customer', 'status', 'total', 'rep'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const baseList = useBaseList<Quote, any>({
    entityName: 'quote',
    entityNamePlural: 'quotes',
    useStore: useQuotesEnhanced,
    features: {
      allowCreate: true,
      allowEdit: true,
      allowDelete: true,
      allowBulkActions: false,
      allowExport: false,
      allowImport: false,
      allowSearch: true,
      allowFilters: true,
      allowStats: false,
    },
    permissions: {
      create: Permission.QUOTE_CREATE,
      update: Permission.QUOTE_UPDATE,
      delete: Permission.QUOTE_DELETE,
    },
    columns,
    filters,
    onEdit: onQuoteEdit,
    onCreate: onQuoteCreate,
    authContext: quoteAuth,
  });

  return (
    <div className="quote-list">
      <BaseList
        title="Quotes"
        filters={baseList.renderFilters()}
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No quotes found."
        onEdit={baseList.handleEdit}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
    </div>
  );
};

export default QuoteList;
