import React, { useState } from 'react';
import { Button, CircularProgress, Alert, Stack } from '@mui/material';

export interface ImpersonateButtonProps {
  /** Email of whoever is currently logged in. */
  currentUserEmail?: string | null;
  /** The one email this button is ever shown to — set from an env var, never hardcoded in the app. */
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
 * Dev-only "log in as this user" action. Hidden unless running a dev build
 * AND the current user matches the configured allowed email — this is a
 * personal debugging shortcut, never a feature other users should see.
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
  // schema only serves the section to the allowed user), so skip the email check.
  const emailOk =
    allowedEmail === null ||
    (!!allowedEmail && !!currentUserEmail && currentUserEmail.toLowerCase() === allowedEmail.toLowerCase());
  const visible =
    isDev &&
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
