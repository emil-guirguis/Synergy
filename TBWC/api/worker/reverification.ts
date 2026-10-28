/**
 * 90-day re-verification for rep-type users. Cron (see index.ts scheduled
 * handler) locks reps whose last_verified_at has gone stale and mails them a
 * verify link; clicking it (routes/verify.ts) unlocks the account via
 * consumeVerifyToken. Mirrors the rep_leads invite-token pattern
 * (repLeadsService.ts) but recurring instead of one-time.
 */
import { Env, execQuery } from './db';
import { sendMail } from './mail';

const LOCK_AFTER_DAYS = 90;
const TOKEN_TTL_DAYS = 7;

/** Lock any rep past the re-verification window and email them a new link. */
export async function lockStaleReps(env: Env): Promise<void> {
  const stale = await execQuery(
    env,
    `SELECT u.id, u.email, u.first_name
     FROM public.users u
     JOIN public.role r ON r.role_id = COALESCE(u.role_id, (
       SELECT role_id FROM public.role WHERE tenant_id IS NULL AND code = 'rep'
     ))
     WHERE r.code = 'rep'
       AND u.approved = true
       AND u.locked_at IS NULL
       AND u.last_verified_at < now() - ($1 || ' days')::interval`,
    [LOCK_AFTER_DAYS],
    'lockStaleReps:select'
  );

  for (const row of stale.rows) {
    const token = crypto.randomUUID();
    await execQuery(
      env,
      `UPDATE public.users
       SET locked_at = now(),
           verify_token = $2,
           verify_token_expires_at = now() + ($3 || ' days')::interval
       WHERE id = $1`,
      [row.id, token, TOKEN_TTL_DAYS],
      'lockStaleReps:lock'
    );

    const portalUrl = (env.PORTAL_URL || '/').replace(/\/*$/, '/');
    const link = `${portalUrl}verify?token=${token}`;
    try {
      await sendMail(env, { type: 'reverify', email: row.email, firstName: row.first_name, link });
    } catch (e) {
      console.error(`[reverification] send-mail failed for ${row.email}:`, e instanceof Error ? e.message : e);
    }
  }
}

export type VerifyResult = 'ok' | 'invalid' | 'expired';

/** Consume a mailed verify token: unlocks the account and resets the 90-day clock. */
export async function consumeVerifyToken(env: Env, token: string): Promise<VerifyResult> {
  const res = await execQuery(
    env,
    `SELECT id, verify_token_expires_at FROM public.users WHERE verify_token = $1`,
    [token],
    'consumeVerifyToken:lookup'
  );
  const row = res.rows[0];
  if (!row) return 'invalid';
  if (new Date(row.verify_token_expires_at).getTime() < Date.now()) return 'expired';

  await execQuery(
    env,
    `UPDATE public.users
     SET locked_at = NULL,
         verify_token = NULL,
         verify_token_expires_at = NULL,
         last_verified_at = now()
     WHERE id = $1`,
    [row.id],
    'consumeVerifyToken:unlock'
  );
  return 'ok';
}
