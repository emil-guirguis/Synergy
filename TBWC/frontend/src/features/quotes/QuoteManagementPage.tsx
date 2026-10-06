import React from 'react';
import { EntityManagementPage } from '@meterit/framework-frontend/components/entity';
import { QuoteList } from './QuoteList';
import { QuoteForm } from './QuoteForm';
import { useAuth } from '../../hooks/useAuth';
import type { Quote } from '../../types/quote';

export const QuoteManagementPage: React.FC = () => {
  const { isAdmin } = useAuth();
  // Reps open quotes read-only (PUT /api/quotes/:id is quote:write,
  // which reps don't have — migration 056), so drop the Save button rather
  // than show one that can only 403, and title the modal "View Quote" —
  // nothing in it is editable for them. Same pattern as OrderManagementPage.
  return (
    <EntityManagementPage<Quote>
      title="Quote"
      moduleIcon="quotes"
      modalSize="lg"
      schemaName="quote"
      showSaveButton={isAdmin}
      editLabel={isAdmin ? undefined : 'View Quote'}
      renderList={({ onEdit, onCreate }) => <QuoteList onQuoteEdit={onEdit} onQuoteCreate={onCreate} />}
      renderForm={({ entity, onCancel }) => <QuoteForm quote={entity} onCancel={onCancel} />}
    />
  );
};

export default QuoteManagementPage;
