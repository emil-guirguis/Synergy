import React from 'react';
import { Link } from '@mui/material';

/**
 * Pulls carrier + tracking numbers out of an order's shipping_tracking text
 * (the invoice FREIGHT line's free-typed Desc — see orderInvoiceStatus.ts),
 * so the order form can link straight to the carrier's own tracking page —
 * inline, in place, rather than duplicating the numbers into a separate list.
 *
 * UPS's "1Z" + 16 alphanumeric format is unique to UPS and unambiguous
 * wherever it appears, so it's matched on its own. A bare 12- or 15-digit
 * run isn't unique the same way — FedEx uses both, but so do PRO numbers from
 * LTL freight carriers this company also uses (SAIA, Forward Air, Central
 * Transport, XPO, TForce, Mountain Valley Express...), and a chunk of the
 * data is just "Tracking: <digits>" with no carrier named at all. Guessing
 * FedEx there would occasionally link a freight PRO number straight to the
 * wrong carrier's site, so it's only treated as FedEx when the text actually
 * says so. Anything else (a named LTL carrier, or no number at all) has no
 * single reliable tracking URL and is left as plain, unlinked text.
 */
export interface ParsedTracking {
  carrier: 'UPS' | 'FedEx';
  number: string;
  url: string;
}

const UPS_RE = /\b1Z[0-9A-Z]{16}\b/g;
const FEDEX_NUMBER_RE = /\b\d{12}\b|\b\d{15}\b/g;

/** All distinct tracking numbers in the text (a multi-package shipment's Desc
 *  can carry several, one per line/comma/whatever separator was typed —
 *  matching is separator-agnostic since \b just needs a number boundary). */
export function parseAllTracking(text: string | null | undefined): ParsedTracking[] {
  if (!text) return [];
  const found = new Map<string, ParsedTracking>();

  for (const m of text.matchAll(UPS_RE)) {
    found.set(m[0], { carrier: 'UPS', number: m[0], url: `https://www.ups.com/track?tracknum=${m[0]}` });
  }

  if (/fedex/i.test(text)) {
    for (const m of text.matchAll(FEDEX_NUMBER_RE)) {
      if (!found.has(m[0])) {
        found.set(m[0], { carrier: 'FedEx', number: m[0], url: `https://www.fedex.com/fedextrack/?trknbr=${m[0]}` });
      }
    }
  }

  return [...found.values()];
}

/**
 * Renders the raw text with each recognized tracking number swapped for a
 * clickable link to that carrier's tracking page — everything else (carrier
 * name, dates, notes) stays as plain text, in its original place, so nothing
 * is shown twice.
 */
export function renderTrackingText(text: string, tracking: ParsedTracking[]): React.ReactNode {
  if (!tracking.length) return text;
  const byNumber = new Map(tracking.map((t) => [t.number, t]));
  const re = new RegExp(`(${tracking.map((t) => t.number).join('|')})`, 'g');
  return text.split(re).map((part, i) => {
    const match = byNumber.get(part);
    if (!match) return <React.Fragment key={i}>{part}</React.Fragment>;
    return (
      <Link
        key={i}
        href={match.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Track via ${match.carrier}`}
        onClick={(e) => e.stopPropagation()}
      >
        {part}
      </Link>
    );
  });
}
