/**
 * The case that prompted this: the caller asked the assistant to notify
 * "Jennifer Crenshaw" and was told no such user exists, because the user on
 * file is "Jenifer Crenshaw" — one n — and the old tool ran a single
 * substring ILIKE on the whole query string.
 */
import { describe, it, expect } from 'vitest';
import { searchTerms, prefixTerms, buildUserSearchQuery, rankUsers, type UserSearchRow } from './userSearch';

const jenifer: UserSearchRow = {
  id: 'u1',
  first_name: 'Jenifer',
  last_name: 'Crenshaw',
  email: 'jenifer@example.com',
  agency_name: 'TBWC',
};
const emil: UserSearchRow = {
  id: 'u2',
  first_name: 'Emil',
  last_name: 'Guirguis',
  email: 'emil@example.com',
  agency_name: 'TBWC',
};
const jenniferSmith: UserSearchRow = {
  id: 'u3',
  first_name: 'Jennifer',
  last_name: 'Smith',
  email: 'jsmith@example.com',
  agency_name: 'TBWC',
};

/** Stands in for Postgres: applies the generated predicate's semantics
 *  (any term, case-insensitive substring, over the same five fields). */
function fakeQuery(rows: UserSearchRow[], terms: string[]): UserSearchRow[] {
  return rows.filter((r) => {
    const fields = [
      r.first_name ?? '',
      r.last_name ?? '',
      r.email ?? '',
      r.agency_name ?? '',
      `${r.first_name ?? ''} ${r.last_name ?? ''}`,
    ].map((f) => f.toLowerCase());
    return terms.some((t) => fields.some((f) => f.includes(t.toLowerCase())));
  });
}

function search(rows: UserSearchRow[], text: string): UserSearchRow[] {
  let terms = searchTerms(text);
  let found = rankUsers(fakeQuery(rows, terms), terms);
  if (found.length === 0) {
    terms = prefixTerms(text);
    found = terms.length ? rankUsers(fakeQuery(rows, terms), terms) : [];
  }
  return found;
}

describe('searchTerms', () => {
  it('keeps the whole query as well as each word, longest first', () => {
    // Equal-length words keep their original order; only length decides rank.
    expect(searchTerms('Jennifer Crenshaw')).toEqual(['Jennifer Crenshaw', 'Jennifer', 'Crenshaw']);
  });

  it('drops words that describe the person instead of naming them', () => {
    expect(searchTerms('the user Emil')).toEqual(['the user Emil', 'Emil']);
  });

  it('strips surrounding punctuation but keeps e-mail characters', () => {
    expect(searchTerms('"Crenshaw",')).toEqual(['Crenshaw']);
    expect(searchTerms('jenifer@example.com')).toEqual(['jenifer@example.com']);
  });

  it('returns nothing for an empty query', () => {
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('prefixTerms', () => {
  it('cuts each word back far enough to survive a misspelling', () => {
    expect(prefixTerms('Jennifer')).toEqual(['Jen']);
  });

  it('has nothing to add when every word is already short', () => {
    expect(prefixTerms('Al Ed')).toEqual([]);
  });
});

describe('buildUserSearchQuery', () => {
  it('parameterises every term and the limit (no interpolated values)', () => {
    const { sql, params } = buildUserSearchQuery(['Jennifer Crenshaw', 'Crenshaw'], 10);
    expect(params).toEqual(['Jennifer Crenshaw', 'Crenshaw', 10]);
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('LIMIT $3');
    expect(sql).not.toContain('Crenshaw');
  });
});

describe('rankUsers', () => {
  it('puts a full-name match above a row sharing only one word', () => {
    const bobSmith: UserSearchRow = { id: 'u4', first_name: 'Bob', last_name: 'Smith', email: 'bob@example.com' };
    const terms = searchTerms('Jennifer Smith');
    const ranked = rankUsers([bobSmith, jenniferSmith], terms);
    expect(ranked.map((r) => r.id)).toEqual(['u3', 'u4']);
  });

  it('does not surface a near-miss on one word when another row matches the rest', () => {
    // "Jenifer Crenshaw" shares neither "Jennifer" nor "Smith" as a substring.
    expect(rankUsers([jenifer], searchTerms('Jennifer Smith'))).toEqual([]);
  });

  it('drops rows that match none of the terms', () => {
    expect(rankUsers([emil], searchTerms('Crenshaw'))).toEqual([]);
  });
});

describe('search_users end to end', () => {
  const rows = [jenifer, emil, jenniferSmith];

  it('finds Jenifer Crenshaw when asked for "Jennifer Crenshaw"', () => {
    const found = search(rows, 'Jennifer Crenshaw');
    expect(found[0]).toMatchObject({ first_name: 'Jenifer', last_name: 'Crenshaw' });
  });

  it('finds her from the misspelled first name alone, via the prefix retry', () => {
    const found = search([jenifer, emil], 'Jennifer');
    expect(found.map((r) => r.id)).toEqual(['u1']);
  });

  it('still prefers the exact person when the spelling is right', () => {
    expect(search(rows, 'Jenifer Crenshaw')[0].id).toBe('u1');
    expect(search(rows, 'Jennifer Smith')[0].id).toBe('u3');
  });

  it('matches a bare first name, which is a valid query on its own', () => {
    expect(search(rows, 'Emil').map((r) => r.id)).toEqual(['u2']);
  });

  it('matches on e-mail', () => {
    expect(search(rows, 'jsmith@example.com').map((r) => r.id)).toEqual(['u3']);
  });

  it('returns nobody for a name that is not there at all', () => {
    expect(search(rows, 'Zbigniew Kowalczyk')).toEqual([]);
  });

  it('does not return everyone just because they share an agency', () => {
    expect(search(rows, 'Crenshaw').map((r) => r.id)).toEqual(['u1']);
  });
});
