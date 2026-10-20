import React from 'react';
import { Alert, Box, CircularProgress } from '@mui/material';
import { BaseForm, ReferenceSearchField } from '@meterit/framework-frontend/components/form';
import { ChildRowsGrid } from '@meterit/framework-frontend/components/datagrid/';
import { DocumentsGrid, type DocumentRecord } from '@meterit/framework-frontend/documents';
import { useQuotesEnhanced, quoteLinesApi } from './quotesStore';
import { buildLinePayloads, extractQuotePdf } from './quotePdfParse';
import { documentsApi, documentsStorage } from '../../services/documentsClient';
import { classifyDocTypeForFile } from '../../shared/docTypeClassifier';
import { tbwcReferenceSearch, aiMatchInventory } from '../../shared/referenceSearch';
import { useAuth } from '../../hooks/useAuth';
import type { Quote } from '../../types/quote';

const MAX_PARSE_PAGES = 3;

/** Same rule as QuoteImportPanel's classifyQuoteFile: any non-email PDF is a quote-revision
 *  candidate worth parsing for a BOM table — a generic doc_type (e.g. the shared classifier's
 *  filename-only "quote" guess landing on a non-PDF) isn't trustworthy enough on its own. */
function looksLikeQuotePdf(fileName: string): boolean {
  return /\.pdf$/i.test(fileName) && !/email/i.test(fileName);
}

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
  // Line items have their own grants (quoteGridLine:*, migration 094) — Settings >
  // Roles > Quote > Line Items — independent of quote:write on the header.
  const canAddLines = scopeOf('quoteGridLine:create') !== null;
  const canEditLines = scopeOf('quoteGridLine:write') !== null;
  const canDeleteLines = scopeOf('quoteGridLine:delete') !== null;
  // New quote: pre-fill txn_date with today, visibly set the moment the form
  // opens — mirrors OrderList's onCreate prefill (routes/quotes.ts's POST /
  // default is just the fallback if this is ever skipped).
  const withTodayDefault = (q?: Quote) => (q?.id ? q : { ...q, txn_date: q?.txn_date ?? new Date().toISOString().slice(0, 10) } as Quote);
  const [freshQuote, setFreshQuote] = React.useState<Quote | undefined>(quote?.id ? undefined : withTodayDefault(quote));
  const [fetching, setFetching] = React.useState(!!quote?.id);
  const [pendingCustomer, setPendingCustomer] = React.useState<PendingCustomer | null>(null);
  // Bumped after an auto-parsed PDF inserts line items, so ChildRowsGrid (which only loads
  // once per parentId) re-fetches and shows them without a full-page refetch/spinner.
  const [linesReloadKey, setLinesReloadKey] = React.useState(0);
  const [docParseNotice, setDocParseNotice] = React.useState<string | null>(null);

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
      setFreshQuote(withTodayDefault(quote));
      setFetching(false);
      return;
    }
    void reload(quote.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quote?.id]);

  // BaseForm's fieldsToClean strips 'lines' and 'customer_list_id' from every
  // save: lines save themselves per row (ChildRowsGrid -> /quotes/:id/lines),
  // never with the header, and customer_list_id is a one-time picker with no
  // visible input of its own once picked. Wrapping create/update to splice
  // the pending customer back in means a create/PUT only carries it when the
  // picker was actually touched this session.
  const applyPending = React.useCallback((data: any) => ({
    ...data,
    ...(pendingCustomer ? { customer_list_id: pendingCustomer.list_id, customer_name: pendingCustomer.name } : {}),
  }), [pendingCustomer]);

  const formStore = React.useMemo(() => ({
    ...quotes,
    createItem: (data: any) => quotes.createItem(applyPending(data)),
    updateItem: (id: string, data: any) => quotes.updateItem(id, applyPending(data)),
  }), [quotes, applyPending]);

  /**
   * Mirrors QuoteImportPanel's "only touch lines when the quote has ZERO" rule, just fired
   * off a single document upload instead of a folder sweep: a PDF attached to a quote that
   * already has lines (hand-entered or previously parsed) is never auto-parsed, and the
   * quote's displayed total (always SUM(quote_line.amount) server-side, routes/quotes.ts) is
   * silently re-fetched afterward — not via reload(), which would show the full-page spinner
   * over a form the user may still be editing.
   */
  const handleDocUploaded = React.useCallback((file: File, _record: DocumentRecord) => {
    const quoteId = freshQuote?.id;
    if (!quoteId || !canAddLines || !looksLikeQuotePdf(file.name)) return;
    void (async () => {
      try {
        const existingLines = await quoteLinesApi.list(quoteId);
        if (existingLines.length > 0) return;
        const { header, lines } = await extractQuotePdf(file, MAX_PARSE_PAGES);
        const payloads = buildLinePayloads(lines, header.total ?? null);
        if (!payloads.length) {
          setDocParseNotice(`No line items found in the first ${MAX_PARSE_PAGES} pages of "${file.name}".`);
          return;
        }
        for (const payload of payloads) {
          await quoteLinesApi.create(quoteId, payload);
        }
        setLinesReloadKey((k) => k + 1);
        quotes.fetchItem(String(quoteId)).then((fresh) => setFreshQuote(fresh as Quote)).catch(() => undefined);
        setDocParseNotice(`Added ${payloads.length} line item(s) parsed from "${file.name}".`);
      } catch (e: any) {
        setDocParseNotice(`Could not parse line items from "${file.name}": ${e?.message || e}`);
      }
    })();
  }, [freshQuote?.id, canAddLines, quotes]);

  if (fetching) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
        <CircularProgress />
      </Box>
    );
  }

  return (
    <Box>
      {docParseNotice && (
        <Alert severity="info" sx={{ mb: 2 }} onClose={() => setDocParseNotice(null)}>
          {docParseNotice}
        </Alert>
      )}
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
        renderCustomField={(fieldName, fieldDef, _value, error, _isDisabled, onChange) => {
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
            // Rows need a quote_id to hang off — same rule as Documents below.
            if (!freshQuote?.id) {
              return <Alert severity="info">Save the quote before adding line items.</Alert>;
            }
            return (
              <ChildRowsGrid
                schemaName="quoteGridLine"
                parentId={freshQuote.id}
                api={quoteLinesApi}
                search={tbwcReferenceSearch}
                canCreate={canAddLines}
                canEdit={canEditLines}
                canDelete={canDeleteLines}
                reloadKey={linesReloadKey}
                totalField="amount"
                voiceAdd={canAddLines ? { column: 'qb_item_id', quantityField: 'quantity', aiFallback: aiMatchInventory } : undefined}
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
                schemaName="quoteGridDocument"
                canCreate={scopeOf('quoteGridDocument:create') !== null}
                canEdit={scopeOf('quoteGridDocument:write') !== null}
                canDelete={scopeOf('quoteGridDocument:delete') !== null}
                onUploaded={handleDocUploaded}
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
