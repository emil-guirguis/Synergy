/**
 * Shared auth mock for route tests.
 *
 * requirePermission() makes two DB lookups: the user row, then that user's role
 * grants. A blanket `query` mock answers both with the same rows, which gives
 * the grant lookup a user row and leaves the caller with no permissions at all.
 * This routes by SQL so each lookup gets what it asks for.
 *
 * Test-only, but it lives next to the worker rather than under a test folder so
 * the route tests can import it by relative path like everything else they use.
 */
import { PERMISSIONS } from './permissions';

/** Every catalogued permission, unscoped — the seeded admin role's grants. */
export const ADMIN_GRANT_ROWS = PERMISSIONS.map((permission) => ({
  permission,
  scope: 'all',
  hidden_fields: [] as string[],
}));

/**
 * A `query` implementation that authenticates `user` as an administrator.
 * role_id is injected rather than required on every fixture: the real column is
 * resolved by getCachedUser's COALESCE, which a mocked query never runs.
 */
export function authQuery(user: any, grants = ADMIN_GRANT_ROWS) {
  return async (_env: any, sql: string) =>
    (/role_permission/.test(String(sql))
      ? { rows: grants }
      : { rows: [{ role_id: 1, ...user }] }) as any;
}

/**
 * Queue the two results requirePermission consumes, for tests that queue their
 * route's own query results after the auth ones. Returns the mock so the
 * route's own `.mockResolvedValueOnce(...)` can be chained on as before.
 *
 * Pair with clearPermissionCache() in beforeEach: grants are cached per role,
 * so without clearing it the second test in a file wouldn't consume the grant
 * result and every later queued value would be off by one.
 */
export function queueAuth(mockQuery: any, user: any, grants = ADMIN_GRANT_ROWS) {
  mockQuery
    .mockResolvedValueOnce({ rows: [{ role_id: 1, ...user }] })
    .mockResolvedValueOnce({ rows: grants });
  return mockQuery;
}
