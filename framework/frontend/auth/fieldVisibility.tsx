import { createContext, useContext } from 'react';

/**
 * Per-role field visibility, made available to framework components that build
 * their own columns.
 *
 * A role grant can hide individual fields (Settings > Roles > … > Columns,
 * stored as hidden_fields / fieldAccess view:false on that grant), and the API
 * already redacts those fields out of every row it returns. A grid that builds
 * its columns from the schema alone therefore kept rendering the column —
 * present, headed, and permanently blank — so unticking a column in Roles
 * looked like it did nothing. Components read this to drop the column too.
 *
 * Outside a provider nothing is hidden, so a component behaves exactly as it
 * did before; an app opts in once by wrapping its tree in
 * <FieldVisibilityProvider value={auth.isFieldVisible}>.
 */
export type IsFieldVisible = (permission: string, field: string) => boolean;

const ALL_VISIBLE: IsFieldVisible = () => true;

export const FieldVisibilityContext = createContext<IsFieldVisible>(ALL_VISIBLE);

export function FieldVisibilityProvider({
  value,
  children,
}: {
  /** The app's own check — typically its auth context's isFieldVisible. */
  value: IsFieldVisible;
  children: React.ReactNode;
}) {
  return <FieldVisibilityContext.Provider value={value}>{children}</FieldVisibilityContext.Provider>;
}

/** `(permission, field) => boolean`; always-true outside a provider. */
export function useFieldVisibility(): IsFieldVisible {
  return useContext(FieldVisibilityContext);
}
