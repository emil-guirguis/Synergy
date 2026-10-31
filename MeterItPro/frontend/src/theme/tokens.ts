/**
 * MeterItPro design tokens — the single source of truth for colour.
 *
 * Before this file the palette lived in two places that had to be hand-kept in
 * agreement: `index.css`'s `--color-*` custom properties and ~77 hex literals
 * inside `muiTheme.ts`. Both are now generated from here — `createMipTheme`
 * reads these objects, and `index.css` declares the same values as custom
 * properties under `:root` / `:root[data-theme='dark']` for plain CSS.
 *
 * Keep the two token sets structurally identical: `createMipTheme` indexes the
 * same keys regardless of mode.
 *
 * ── On the dark set ──────────────────────────────────────────────
 * The light values are the Jul 2026 "Modern SaaS" indigo palette, unchanged.
 * The dark values are derived, not re-designed:
 *   • Brand indigo lifts one step (#4f46e5 -> #818cf8). Indigo-600 on a dark
 *     ground fails contrast; #818cf8 is already this palette's `primary.light`,
 *     so the hue is unchanged.
 *   • Neutrals are a cool slate ramp, not pure black, to keep the soft SaaS
 *     feel rather than an OLED look.
 *   • Elevation inverts its mechanism. The light theme uses soft
 *     rgba(16,24,40,…) drop shadows, which are invisible on dark; dark leans on
 *     surface steps (background -> surface -> surfaceSubtle) plus a much
 *     stronger black shadow for genuinely floating things like dialogs.
 */

export interface MipColorTokens {
  // Brand
  primary: string;
  primaryLight: string;
  primaryDark: string;
  primaryContrast: string;
  secondary: string;
  secondaryLight: string;
  secondaryDark: string;
  secondaryContrast: string;

  // Semantic
  error: string;
  errorLight: string;
  errorDark: string;
  warning: string;
  warningLight: string;
  warningDark: string;
  info: string;
  infoDark: string;
  success: string;
  successDark: string;

  // Surfaces
  background: string;
  surface: string;
  /** One step up from surface: table heads, inset panels. */
  surfaceSubtle: string;
  border: string;
  borderLight: string;
  /** Visible border for outlined controls. */
  borderStrong: string;

  // Text
  textPrimary: string;
  textSecondary: string;
  textDisabled: string;

  // Overlays — alpha so they compose over whatever is beneath
  hoverOverlay: string;
  hoverOverlayStrong: string;
  primaryTint: string;
  primaryTintStrong: string;
  rowHoverTint: string;
  focusRing: string;

  // Chip / Alert fills and their text
  chipPrimaryBg: string;
  chipPrimaryText: string;
  chipSuccessBg: string;
  chipSuccessText: string;
  chipErrorBg: string;
  chipErrorText: string;
  chipWarningBg: string;
  chipWarningText: string;
  alertSuccessBg: string;
  alertErrorBg: string;
  alertWarningBg: string;
  alertInfoBg: string;

  // Inputs
  inputBg: string;
  inputPlaceholder: string;
  inputBorder: string;
  inputBorderHover: string;
  /** Tints the native date/time picker glyph to match the text colour. */
  calendarIndicatorFilter: string;

  // Misc chrome
  tooltipBg: string;
  tooltipText: string;
  gradientBrand: string;

  // Elevation
  shadowSm: string;
  shadowMd: string;
  shadowLg: string;
  shadowPrimary: string;
  shadowPrimaryHover: string;
}

export const lightTokens: MipColorTokens = {
  primary: '#4f46e5',
  primaryLight: '#818cf8',
  primaryDark: '#4338ca',
  primaryContrast: '#ffffff',
  secondary: '#7c3aed',
  secondaryLight: '#a78bfa',
  secondaryDark: '#6d28d9',
  secondaryContrast: '#ffffff',

  error: '#dc2626',
  errorLight: '#f87171',
  errorDark: '#b91c1c',
  warning: '#f59e0b',
  warningLight: '#fbbf24',
  warningDark: '#d97706',
  info: '#0ea5e9',
  infoDark: '#0369a1',
  success: '#16a34a',
  successDark: '#15803d',

  background: '#fafafa',
  surface: '#ffffff',
  surfaceSubtle: '#f9fafb',
  border: '#e5e7eb',
  borderLight: '#f3f4f6',
  borderStrong: '#d1d5db',

  textPrimary: '#111827',
  textSecondary: '#6b7280',
  textDisabled: '#9ca3af',

  hoverOverlay: 'rgba(17, 24, 39, 0.04)',
  hoverOverlayStrong: 'rgba(17, 24, 39, 0.05)',
  primaryTint: 'rgba(79, 70, 229, 0.05)',
  primaryTintStrong: 'rgba(79, 70, 229, 0.14)',
  rowHoverTint: 'rgba(79, 70, 229, 0.03)',
  focusRing: 'rgba(79, 70, 229, 0.12)',

  chipPrimaryBg: 'rgba(79, 70, 229, 0.1)',
  chipPrimaryText: '#4338ca',
  chipSuccessBg: 'rgba(22, 163, 74, 0.1)',
  chipSuccessText: '#15803d',
  chipErrorBg: 'rgba(220, 38, 38, 0.1)',
  chipErrorText: '#b91c1c',
  chipWarningBg: 'rgba(245, 158, 11, 0.14)',
  chipWarningText: '#92400e',
  alertSuccessBg: 'rgba(22, 163, 74, 0.08)',
  alertErrorBg: 'rgba(220, 38, 38, 0.08)',
  alertWarningBg: 'rgba(245, 158, 11, 0.1)',
  alertInfoBg: 'rgba(14, 165, 233, 0.08)',

  inputBg: '#ffffff',
  inputPlaceholder: '#9ca3af',
  inputBorder: '#e5e7eb',
  inputBorderHover: '#a5b4fc',
  calendarIndicatorFilter: 'invert(0.6)',

  tooltipBg: '#111827',
  tooltipText: '#ffffff',
  gradientBrand: 'linear-gradient(120deg, #4f46e5 0%, #6d5ae8 55%, #7c3aed 100%)',

  shadowSm: '0 1px 2px rgba(16, 24, 40, 0.05)',
  shadowMd: '0 1px 3px rgba(16, 24, 40, 0.08), 0 4px 12px rgba(16, 24, 40, 0.05)',
  shadowLg: '0 4px 12px rgba(16, 24, 40, 0.08), 0 12px 32px rgba(16, 24, 40, 0.08)',
  shadowPrimary: '0 1px 2px rgba(79, 70, 229, 0.25)',
  shadowPrimaryHover: '0 2px 8px rgba(79, 70, 229, 0.35)',
};

export const darkTokens: MipColorTokens = {
  primary: '#818cf8',
  primaryLight: '#a5b4fc',
  primaryDark: '#6366f1',
  primaryContrast: '#1e1b4b',
  secondary: '#a78bfa',
  secondaryLight: '#c4b5fd',
  secondaryDark: '#8b5cf6',
  secondaryContrast: '#2e1065',

  error: '#f87171',
  errorLight: '#fca5a5',
  errorDark: '#ef4444',
  warning: '#fbbf24',
  warningLight: '#fcd34d',
  warningDark: '#f59e0b',
  info: '#38bdf8',
  infoDark: '#7dd3fc',
  success: '#4ade80',
  successDark: '#86efac',

  background: '#0f1115',
  surface: '#171a21',
  surfaceSubtle: '#1e222b',
  border: '#2a2f3a',
  borderLight: '#22262f',
  borderStrong: '#3a4150',

  textPrimary: '#f3f4f6',
  textSecondary: '#9ca3af',
  textDisabled: '#6b7280',

  hoverOverlay: 'rgba(255, 255, 255, 0.06)',
  hoverOverlayStrong: 'rgba(255, 255, 255, 0.08)',
  primaryTint: 'rgba(129, 140, 248, 0.12)',
  primaryTintStrong: 'rgba(129, 140, 248, 0.22)',
  rowHoverTint: 'rgba(129, 140, 248, 0.08)',
  focusRing: 'rgba(129, 140, 248, 0.25)',

  chipPrimaryBg: 'rgba(129, 140, 248, 0.18)',
  chipPrimaryText: '#c7d2fe',
  chipSuccessBg: 'rgba(74, 222, 128, 0.16)',
  chipSuccessText: '#86efac',
  chipErrorBg: 'rgba(248, 113, 113, 0.16)',
  chipErrorText: '#fca5a5',
  chipWarningBg: 'rgba(251, 191, 36, 0.18)',
  chipWarningText: '#fcd34d',
  alertSuccessBg: 'rgba(74, 222, 128, 0.12)',
  alertErrorBg: 'rgba(248, 113, 113, 0.12)',
  alertWarningBg: 'rgba(251, 191, 36, 0.14)',
  alertInfoBg: 'rgba(56, 189, 248, 0.12)',

  inputBg: '#1e222b',
  inputPlaceholder: '#6b7280',
  inputBorder: '#2a2f3a',
  inputBorderHover: '#6366f1',
  calendarIndicatorFilter: 'invert(0.85)',

  tooltipBg: '#2a2f3a',
  tooltipText: '#f3f4f6',
  gradientBrand: 'linear-gradient(120deg, #4f46e5 0%, #6d5ae8 55%, #7c3aed 100%)',

  // Soft light-mode shadows vanish on dark; these carry real depth, and
  // surface steps do most of the elevation work instead.
  shadowSm: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadowMd: '0 1px 3px rgba(0, 0, 0, 0.5), 0 4px 12px rgba(0, 0, 0, 0.35)',
  shadowLg: '0 4px 12px rgba(0, 0, 0, 0.5), 0 12px 32px rgba(0, 0, 0, 0.45)',
  shadowPrimary: '0 1px 2px rgba(0, 0, 0, 0.4)',
  shadowPrimaryHover: '0 2px 8px rgba(0, 0, 0, 0.5)',
};

export const tokensFor = (mode: 'light' | 'dark'): MipColorTokens =>
  mode === 'dark' ? darkTokens : lightTokens;
