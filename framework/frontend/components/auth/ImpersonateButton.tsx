import React, { useState } from 'react';
import { Button, CircularProgress, Alert, Stack } from '@mui/material';

export interface ImpersonateButtonProps {
  /** Email of whoever is currently logged in. */
  currentUserEmail?: string | null;
  /**
   * The one email this button is shown to, from an env var (dev-only mode), or
   * `null` to say the server already gated it — e.g. TBWC's schema route only
   * serves the Impersonate section to permissions.ts's
   * IMPERSONATE_ALLOWED_EMAILS. `null` also means the button works in a
   * production build; the env-var form stays dev-only.
   */
  allowedEmail?: string | null;
  /** The record being viewed. */
  targetUserId: string | number | undefined;
  /** The caller's own id, so the button hides on your own record. */
  currentUserId?: string | number | null;
  /** Shown in the confirm/loading state, e.g. the target's email. */
  targetLabel?: string;
  /** Does the POST + session swap; the button handles loading/error state around it. */
  onActivate: () => Promise<void>;
}

/**
 * "Log in as this user" action. Two gating modes:
 *   - allowedEmail set    => dev builds only, and only for that email (a
 *                            personal debugging shortcut, MeterItPro).
 *   - allowedEmail={null} => the server decided who may see this, so render in
 *                            production too (TBWC: the Impersonate schema
 *                            section is served to allowed callers only, and
 *                            /users/:id/impersonate re-checks the same list).
 * Either way the button is cosmetic — the route is the real gate.
 */
export const ImpersonateButton: React.FC<ImpersonateButtonProps> = ({
  currentUserEmail,
  allowedEmail,
  targetUserId,
  currentUserId,
  targetLabel,
  onActivate,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Must be written as plain `import.meta.env` — Vite only substitutes that exact
  // text; `import.meta?.env` is left undefined, so isDev was always false.
  const isDev = Boolean((import.meta as any).env?.DEV);
  // allowedEmail === null means the caller already gated on the server (e.g. the
  // schema only serves the section to allowed users), so skip the email check
  // and the dev-build check with it — that mode is meant to ship.
  const serverGated = allowedEmail === null;
  const emailOk =
    serverGated ||
    (!!allowedEmail && !!currentUserEmail && currentUserEmail.toLowerCase() === allowedEmail.toLowerCase());
  const visible =
    (isDev || serverGated) &&
    emailOk &&
    targetUserId !== undefined &&
    String(targetUserId) !== String(currentUserId ?? '');

  if (!visible) return null;

  const handleClick = async () => {
    setLoading(true);
    setError(null);
    try {
      await onActivate();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to log in as this user');
      setLoading(false);
    }
  };

  return (
    <Stack spacing={1} alignItems="flex-start">
      <Button
        variant="outlined"
        color="warning"
        size="small"
        disabled={loading}
        onClick={handleClick}
        startIcon={loading ? <CircularProgress size={14} color="inherit" /> : undefined}
      >
        {loading ? 'Logging in…' : `Log in as${targetLabel ? ` ${targetLabel}` : ' this user'}`}
      </Button>
      {error && <Alert severity="error" sx={{ py: 0 }}>{error}</Alert>}
    </Stack>
  );
};

export default ImpersonateButton;
