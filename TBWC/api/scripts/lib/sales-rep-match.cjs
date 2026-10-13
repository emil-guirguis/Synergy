// Shared by import-quotes-from-folders.cjs (new rows) and
// backfill-sales-rep-id.cjs (existing rows): matches a free-text rep string
// (a firm name like "Bell & McCoy", or "NAME (email, phone)" as parsed off
// a quote PDF cover page) against public.qb_sales_rep.
//
// Quote PDFs print the REP FIRM's own rep (an individual person), but
// qb_sales_rep.name is a mix of individual names and firm names (QuickBooks
// SalesRepEntityRef can point at an Employee, Vendor, or OtherName) — the
// parsed individual's name essentially never matches a qb_sales_rep row
// directly, but their email domain almost always encodes the firm name or
// its short code (e.g. "uesrep.com" -> initial "UES"; "myinvictussales.com"
// contains "invictus" -> "Invictus Sales & Marketing"). So domain is the
// primary signal; the free-text itself is the fallback for the many
// pre-existing rows that only ever stored a firm name, no email.
//
// Deliberately conservative: a wrong rep match is a real permission leak
// (quote.sales_rep_list_id gates row visibility for rep-scoped users, see
// worker/middleware.ts visibleRepListIds + worker/routes/quotes.ts
// ownOnly) — returning null and leaving it for manual assignment is always
// safer than guessing.

const STOPWORDS = new Set([
  'inc', 'llc', 'corp', 'co', 'company', 'and', 'the', 'of', 'for',
  'group', 'associates', 'marketing', 'sales', 'solutions', 'solution',
  'services', 'service', 'electrical', 'north', 'northeast', 'northwest',
  'south', 'southeast', 'southwest', 'east', 'west', 'rep', 'reps',
]);

// qb_sales_rep.name is sometimes a placeholder that doesn't describe the
// rep at all (initial "BA" / name literally "B A" is the firm-level
// Blanchard Associates entry — confirmed by the user, not derivable from
// the row itself). Keyed by initial so the real name can stay whatever QB
// has; distinctiveTokens('B A') would otherwise be empty (both words too
// short) and this rep would be permanently unreachable by the matcher.
const ALIAS_TOKENS_BY_INITIAL = {
  BA: ['blanchard', 'associates'],
};

function normalize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function distinctiveTokens(name) {
  return normalize(name)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function extractDomainRoot(freeText) {
  const m = (freeText || '').match(/@([\w.-]+)\./);
  if (!m) return '';
  return normalize(m[1].replace(/^www\./, ''));
}

/** `client` is a connected pg Client/Pool. */
async function loadRepIndex(client) {
  const r = await client.query('SELECT list_id, initial, name, is_active FROM public.qb_sales_rep');
  return r.rows.map((row) => {
    const alias = ALIAS_TOKENS_BY_INITIAL[row.initial];
    return {
      list_id: row.list_id,
      name: row.name,
      initial: row.initial,
      is_active: row.is_active,
      nameNormalized: normalize(row.name),
      tokens: alias || distinctiveTokens(row.name),
      isGenericFirmAlias: !!alias,
    };
  });
}

/**
 * Returns { list_id, name } on a confident, unambiguous match, else null.
 * `freeText` is whatever's stored/about-to-be-stored in quote.sales_rep —
 * either a bare firm name or "NAME (email, phone)".
 */
function matchSalesRep(freeText, repIndex) {
  const domainRoot = extractDomainRoot(freeText);
  const textNormalized = normalize(freeText);
  const scored = [];
  for (const rep of repIndex) {
    let score = 0;
    if (domainRoot && rep.tokens.some((t) => domainRoot.includes(t))) score += 3;
    if (rep.tokens.some((t) => textNormalized.includes(t))) score += 3;
    // Prefix-only, not substring-anywhere: a short code like "LES" is a
    // substring of ordinary words ("sa-LES") and matched constantly
    // ("BOB FERN...MYPHONENIXSALES.COM" false-matched "Lachut Electrical
    // Sales" on exactly that before this was tightened to word/domain
    // start).
    if (rep.initial && rep.initial.length >= 3) {
      const initialNorm = normalize(rep.initial);
      if (domainRoot && domainRoot.startsWith(initialNorm)) score += 2;
      if (textNormalized.split(' ').some((w) => w.startsWith(initialNorm))) score += 2;
    }
    if (score > 0 && rep.is_active) score += 1; // tie-break toward the active rep of a near-duplicate pair
    if (score > 0) scored.push({ rep, score });
  }
  if (scored.length === 0) return null;

  // A firm-level alias (BA/"blanchard associates") shares its distinctive
  // tokens with every individual rep at that firm — James/Janelle/Joe
  // Blanchard all score on the shared surname "blanchard" too, and with no
  // first name mentioned they're hopelessly tied against EACH OTHER (not
  // against BA). So: try to resolve among the named individuals first —
  // if the text names one specifically (its own extra token/initial signal
  // breaks the tie), that person wins outright and BA is never considered.
  // Only when the individuals can't be told apart (or there are none) does
  // the firm-level alias get a turn — which is exactly the case it exists
  // for: a generic firm reference naming no one in particular.
  function resolveAmong(candidates) {
    if (candidates.length === 0) return null;
    const sorted = [...candidates].sort((a, b) => b.score - a.score);
    const [best, second] = sorted;
    if (best.score < 3) return null;
    if (second && second.score >= best.score - 1) return null;
    return best;
  }

  const individualWinner = resolveAmong(scored.filter((s) => !s.rep.isGenericFirmAlias));
  const winner = individualWinner || resolveAmong(scored.filter((s) => s.rep.isGenericFirmAlias));
  return winner ? { list_id: winner.rep.list_id, name: winner.rep.name } : null;
}

// Shared literal so both callers' memo text matches exactly (lets either
// one idempotently check "did I already flag this row" with a plain
// substring check, and lets a human searching memos find every flagged row
// with one search string regardless of which script touched it).
const UNMATCHED_FLAG = 'Sales rep not matched to qb_sales_rep — manual assignment needed.';

module.exports = { loadRepIndex, matchSalesRep, normalize, distinctiveTokens, extractDomainRoot, UNMATCHED_FLAG };
