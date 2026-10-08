import React, { useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { BaseList } from '@meterit/framework-frontend/components/list';
import { useBaseList } from '@meterit/framework-frontend/components/list/hooks';
import { useSchema } from '@meterit/framework-frontend/components/form/utils/schemaLoader';
import {
  generateColumnsFromSchema,
  generateFiltersFromSchema,
} from '@meterit/framework-frontend/components/list/utils/schemaColumnGenerator';
import { ShareMenu, useShareTarget } from '@meterit/framework-frontend/components/share';
import { useQuotes } from './quotesStore';
import { useAuth } from '../../hooks/useAuth';
import { Permission } from '../../types/auth';
import { searchPeople, shareRecord } from '../../services/shareService';
import { quoteShareUrl, quoteShareTitle } from './quoteShare';
import type { Quote } from '../../types/quote';

interface QuoteListProps {
  onQuoteEdit?: (quote: Quote) => void;
  onQuoteCreate?: () => void;
}

/** TBWC-local quote list. Admins see, edit, create, and delete every quote;
 *  a rep sees only their own (read-only, but may delete one — see
 *  quote:read/write/delete grants, migrations 056 and 075). */
export const QuoteList: React.FC<QuoteListProps> = ({ onQuoteEdit, onQuoteCreate }) => {
  const auth = useAuth();
  const { schema } = useSchema('quote');
  const [searchParams, setSearchParams] = useSearchParams();
  const quotesHook = useQuotes();

  const columns = useMemo(() => {
    if (!schema) return [];
    return generateColumnsFromSchema<Quote>(schema.formFields, {
      fieldOrder: ['ref_number', 'customer_name', 'sales_rep', 'status', 'txn_date', 'total'],
      responsive: 'hide-mobile',
    });
  }, [schema]);

  const filters = useMemo(() => {
    if (!schema) return [];
    return generateFiltersFromSchema(schema.formFields);
  }, [schema]);

  const { shareTarget, openShare, closeShare } = useShareTarget();

  const baseList = useBaseList<Quote, any>({
    entityName: 'quote',
    entityNamePlural: 'quotes',
    useStore: useQuotes,
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
      // checkPermission resolves create/update against the real quote:write
      // grant (admin only today — migration 056 gives every non-admin role
      // quote:read 'own' but no write at all). canUpdate below decides the
      // row affordance, not whether the row opens — a rep still opens it,
      // read-only (see QuoteForm), via onView. quote:delete (migration 075)
      // is separate and scoped 'own' for rep/customer, so canDelete can be
      // true for a rep even though canUpdate is false.
      create: Permission.QUOTE_CREATE,
      update: Permission.QUOTE_UPDATE,
      delete: Permission.QUOTE_DELETE,
    },
    columns,
    filters,
    onEdit: onQuoteEdit,
    onCreate: onQuoteCreate,
    authContext: auth,
  });

  // AI chat search results link here with ?openId=<quote_id> (see
  // features/ai/AiChatPage.tsx) — same pattern as OrderList/InvoiceList.
  useEffect(() => {
    const openId = searchParams.get('openId');
    if (!openId || !onQuoteEdit) return;
    quotesHook
      .fetchItem(openId)
      .then((entity) => entity && onQuoteEdit(entity as unknown as Quote))
      .catch((err) => console.error('[QuoteList] Failed to open quote from AI chat link:', err));
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
    <div className="quote-list">
      <BaseList
        title="Quotes"
        filters={baseList.renderFilters()}
        data={baseList.data}
        columns={baseList.columns}
        loading={baseList.loading}
        error={baseList.error}
        emptyMessage="No quotes found. Create one to get started."
        onCreateClick={baseList.canCreate ? baseList.handleCreate : undefined}
        onEdit={baseList.canUpdate ? baseList.handleEdit : undefined}
        onView={!baseList.canUpdate ? baseList.handleView : undefined}
        onDelete={baseList.canDelete ? baseList.handleDelete : undefined}
        onShare={(quote) => openShare({ url: quoteShareUrl(quote), title: quoteShareTitle(quote) })}
        pagination={baseList.pagination}
        sortBy={baseList.sortBy}
        sortOrder={baseList.sortOrder}
      />
      {baseList.renderDeleteConfirmation()}
      {shareTarget && (
        <ShareMenu
          open={!!shareTarget}
          onClose={closeShare}
          title={shareTarget.title}
          url={shareTarget.url}
          searchPeople={searchPeople}
          onShare={({ recipient, note }) =>
            shareRecord({ recipientUserId: recipient.id, title: shareTarget.title, linkUrl: shareTarget.url, note })
          }
        />
      )}
    </div>
  );
};

export default QuoteList;
