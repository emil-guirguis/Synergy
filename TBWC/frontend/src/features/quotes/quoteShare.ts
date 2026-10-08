import type { Quote } from '../../types/quote';

export const quoteShareUrl = (quote: Quote) => `${window.location.origin}/quotes?openId=${quote.quote_id}`;
export const quoteShareTitle = (quote: Quote) => `Quote ${quote.ref_number ?? quote.quote_id}`;
