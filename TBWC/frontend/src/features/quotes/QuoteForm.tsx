import React from 'react';
import { Alert, Box, CircularProgress } from '@mui/material';
import { BaseForm, ReferenceSearchField } from '@meterit/framework-frontend/components/form';
import { PickableLineItemsGrid } from '@meterit/framework-frontend/components/datagrid/';
import { DocumentsGrid } from '@meterit/framework-frontend/documents';
import { useQuotesEnhanced } from './quotesStore';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { tbwcReferenceSearch } from '../../shared/referenceSearch';
import { useAuth } from '../../hooks/useAuth';
import type { Quote, QuoteLine } from '../../types/quote';

interface PendingCustomer {
  list_id: string;
  name: string;
}

interface QuoteFormProps {
  quote?: Quote;
  onCancel: () => void;
  loading?: boolean;
}

/**
 * Schema-driven quote form (GET /api/schema/quote). Always re-fetches on
 * open rather than trusting the row the list handed it, same rationale as
 * OrderForm (another edit elsewhere could have changed it).
 *
 * Reps (no quote:write grant) get a read-only viewer: BaseForm's variant
 * filter and isDisabled mirror OrderForm's admin/rep split exactly.
 */
export const QuoteForm: React.FC<QuoteFormProps> = ({ quote, onCancel, loading = false }) => {
  const quotes = useQuotesEnhanced();
  const { scopeOf } = useAuth();
  // Driven by the actual quote:write grant (migrations 042/040), not
  // user.is_admin — today only admin holds it, but an employee role could be
  // granted it without code changing here. Covers the form itself and the
  // Documents tab below (documents.ts's own quote:write gate is the real
  // enforcement; this just keeps the UI from offering controls that would 403).
  const canWriteQuotes = scopeOf('quote:write') !== null;
  const variant = canWriteQuotes ? 'admin' : 'rep';
  const readOnly = !canWriteQuotes;
  const [freshQuote, setFreshQuote] = React.useState<Quote | undefined>(quote?.id ? undefined : quote);
  const [fetching, setFetching] = React.useState(!!quote?.id);
  const [pendingLines, setPendingLines] = React.useState<QuoteLine[] | null>(null);
  const [pendingCustomer, setPendingCustomer] = React.useState<PendingCustomer | null>(null);

  const reload = React.useCallback((id: string | number) => {
    setFetching(true);
    return quotes.fetchItem(id)
      .then((fresh) => { setFreshQuote(fresh as Quote); return fresh as Quote; })
      .catch(() => { setFreshQuote(quote); return undefined; })
      .finally(() => setFetching(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quotes]);

  React.useEffect(() => {
    if (!quote?.id) {
      setFreshQuote(quote);
      setFetching(false);
      return;
    }
    void reload(quote.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id]);

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
    ...quotes,
    createItem: (data: any) => quotes.createItem(applyPending(data)),
    updateItem: (id: string, data: any) => quotes.updateItem(id, applyPending(data)),
  }), [quotes, applyPending]);

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      <BaseForm
        schemaName="quote"
        entity={freshQuote}
        store={formStore}
        onCancel={onCancel}
        className="quote-form"
        loading={loading}
        showTabs={true}
        variant={variant}
        isDisabled={readOnly}
        fieldsToClean={['id', 'lines', 'documents', 'customer_list_id']}
        renderCustomField={(fieldName, fieldDef, value, error, _isDisabled, onChange) => {
          if (fieldName === 'customer_list_id') {
            return (
              <ReferenceSearchField
                label={fieldDef?.label ?? 'Customer'}
                config={fieldDef.referenceSearch}
                search={tbwcReferenceSearch}
                disabled={readOnly}
                error={error}
                value={pendingCustomer?.list_id ?? freshQuote?.customer_list_id ?? null}
                valueLabel={pendingCustomer?.name ?? freshQuote?.customer_name ?? null}
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
          if (fieldName === 'documents') {
            if (!freshQuote?.id) {
              return <Alert severity="info">Save the quote before attaching documents.</Alert>;
            }
            return (
              <DocumentsGrid
                entityType="quote"
                entityId={freshQuote.id}
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

export default QuoteForm;
