/**
 * run_sql_query runs as the table owner, which bypasses RLS — so these cover
 * both halves of the guard: that nothing but a read of the app's own tables
 * gets through, and that honest queries are not rejected for merely
 * mentioning a keyword inside a quoted value (the old scan read raw text).
 */
import { describe, it, expect } from 'vitest';
import { checkSqlQuery, stripLiterals } from './sqlGuard';

const ok = (sql: string) => checkSqlQuery(sql).ok;
const error = (sql: string) => checkSqlQuery(sql).error ?? '';

describe('stripLiterals', () => {
  it('blanks string literals but keeps the surrounding SQL', () => {
    expect(stripLiterals("SELECT * FROM t WHERE a = 'insert'")).toBe('SELECT * FROM t WHERE a =         ');
  });

  it('handles an escaped quote inside a literal', () => {
    const stripped = stripLiterals("SELECT * FROM t WHERE a = 'it''s here' AND b = 1");
    expect(stripped).toContain('AND b = 1');
    expect(stripped).not.toContain('here');
  });

  it('blanks line and block comments', () => {
    expect(stripLiterals('SELECT 1 -- drop table x').trim()).toBe('SELECT 1');
    const stripped = stripLiterals('SELECT /* delete */ 1');
    expect(stripped).not.toContain('delete');
    expect(stripped.trim()).toMatch(/^SELECT\s+1$/);
  });

  it('keeps the text the same length so positions still line up', () => {
    const sql = "SELECT * FROM t WHERE a = 'insert' AND b = 2";
    expect(stripLiterals(sql)).toHaveLength(sql.length);
  });
});

describe('checkSqlQuery allows legitimate reads', () => {
  it('accepts a plain SELECT', () => {
    expect(ok('SELECT ref_number FROM public.qb_sales_order LIMIT 5')).toBe(true);
  });

  it('accepts a CTE', () => {
    expect(ok('WITH recent AS (SELECT 1 AS n) SELECT n FROM recent')).toBe(true);
  });

  it('accepts information_schema, which the tool relies on for column discovery', () => {
    expect(ok("SELECT column_name FROM information_schema.columns WHERE table_name = 'qb_invoice'")).toBe(true);
  });

  it('accepts a keyword appearing inside a quoted value', () => {
    // The whole point of stripping literals first.
    expect(ok("SELECT * FROM public.qb_sales_order WHERE notes = 'insert the panel'")).toBe(true);
    expect(ok("SELECT * FROM public.document WHERE doc_type = 'Update'")).toBe(true);
  });

  it('accepts a trailing semicolon', () => {
    const result = checkSqlQuery('SELECT 1;');
    expect(result.ok).toBe(true);
    expect(result.statement).toBe('SELECT 1');
  });
});

describe('checkSqlQuery blocks writes', () => {
  it.each([
    'DELETE FROM public.users',
    'UPDATE public.users SET is_admin = true',
    'INSERT INTO public.users (id) VALUES (1)',
    'DROP TABLE public.notification',
    'SELECT 1; DROP TABLE public.notification',
    'TRUNCATE public.qb_invoice',
    'GRANT ALL ON public.users TO anon',
  ])('rejects %s', (sql) => {
    expect(ok(sql)).toBe(false);
  });

  it('rejects anything that is not a SELECT or WITH', () => {
    expect(error('EXPLAIN SELECT 1')).toMatch(/only select/i);
  });

  it('rejects a write hidden behind a comment', () => {
    expect(ok('SELECT 1 /* x */ ; DELETE FROM public.users')).toBe(false);
  });
});

describe('checkSqlQuery blocks out-of-bounds objects', () => {
  it.each([
    'SELECT * FROM auth.users',
    'SELECT * FROM storage.objects',
    'SELECT * FROM vault.secrets',
    'SELECT * FROM pg_authid',
    'SELECT * FROM pg_shadow',
    'SELECT rolname FROM pg_roles',
    'SELECT * FROM pg_stat_activity',
  ])('rejects %s', (sql) => {
    expect(ok(sql)).toBe(false);
  });

  it('explains what is allowed instead', () => {
    expect(error('SELECT * FROM auth.users')).toMatch(/public schema|information_schema/i);
  });

  it('does not mistake a column named like a blocked schema for one', () => {
    expect(ok('SELECT auth_method FROM public.users')).toBe(true);
    expect(ok("SELECT * FROM public.document WHERE storage_path LIKE 'rep-docs/%'")).toBe(true);
  });
});

describe('checkSqlQuery input handling', () => {
  it('rejects empty input', () => {
    expect(error('   ')).toMatch(/required/i);
    expect(error(undefined as any)).toMatch(/required/i);
  });
});
