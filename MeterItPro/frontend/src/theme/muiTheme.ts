import { createTheme } from '@mui/material/styles';
import { tokensFor } from './tokens';

/**
 * Modern SaaS theme for MUI
 * Indigo/violet accent, Inter typeface, soft layered shadows, generous radii.
 *
 * ── Design system changes applied ──────────────────────────────
 * • Apr 2026: MuiTableHead fontSize 11px — approved in design system review
 * • Jul 2026: Modern SaaS refresh — indigo palette, Inter, shadow-based
 *   elevation (replaces border-based cards), pill-ish buttons
 * • Oct 2026: colour moved out to ./tokens.ts and the theme became a factory,
 *   so light and dark are the same structure with a different token set.
 *   Nothing here should hold a hex literal — add a token instead, and mirror
 *   it as a `--color-*` custom property in index.css if plain CSS needs it.
 */
export const createMipTheme = (mode: 'light' | 'dark' = 'light') => {
  const t = tokensFor(mode);

  return createTheme({
    palette: {
      // Tells MUI which way round its own defaults go, for anything not
      // explicitly overridden below.
      mode,
      primary: {
        main: t.primary,
        light: t.primaryLight,
        dark: t.primaryDark,
        contrastText: t.primaryContrast,
      },
      secondary: {
        main: t.secondary,
        light: t.secondaryLight,
        dark: t.secondaryDark,
        contrastText: t.secondaryContrast,
      },
      error: {
        main: t.error,
        light: t.errorLight,
        dark: t.errorDark,
      },
      warning: {
        main: t.warning,
        light: t.warningLight,
        dark: t.warningDark,
      },
      info: {
        main: t.info,
      },
      success: {
        main: t.success,
      },
      background: {
        default: t.background,
        paper: t.surface,
      },
      text: {
        primary: t.textPrimary,
        secondary: t.textSecondary,
        disabled: t.textDisabled,
      },
      divider: t.border,
    },
    shape: {
      borderRadius: 10,
    },
    typography: {
      fontFamily: '"Inter", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
      h1: { fontWeight: 700, letterSpacing: '-0.02em' },
      h2: { fontWeight: 700, letterSpacing: '-0.02em' },
      h3: { fontWeight: 600, letterSpacing: '-0.01em' },
      h4: { fontWeight: 600, letterSpacing: '-0.01em' },
      h5: { fontWeight: 600 },
      h6: { fontWeight: 600 },
      subtitle1: { fontWeight: 500, color: t.textSecondary },
      subtitle2: { fontWeight: 500, color: t.textSecondary },
      body1: { fontSize: '0.9375rem' },
      body2: { fontSize: '0.875rem', color: t.textSecondary },
      button: { textTransform: 'none', fontWeight: 600 },
      caption: { color: t.textDisabled },
    },
    components: {
      // ── AppBar ────────────────────────────────────────────────
      MuiAppBar: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            background: t.gradientBrand,
            borderBottom: 'none',
          },
        },
      },
      // ── Card ─────────────────────────────────────────────────
      MuiCard: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            border: `1px solid ${t.borderLight}`,
            borderRadius: 16,
            boxShadow: t.shadowSm,
            transition: 'box-shadow 0.2s ease, transform 0.2s ease',
            '&:hover': {
              boxShadow: t.shadowMd,
            },
          },
        },
      },
      MuiCardHeader: {
        styleOverrides: {
          root: {
            paddingBottom: 8,
          },
          title: {
            fontSize: '1rem',
            fontWeight: 600,
            color: t.textPrimary,
          },
          subheader: {
            fontSize: '0.8125rem',
            color: t.textSecondary,
          },
        },
      },
      // ── Paper ─────────────────────────────────────────────────
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: {
          root: {
            border: `1px solid ${t.borderLight}`,
            borderRadius: 12,
          },
          elevation1: {
            border: 'none',
            boxShadow: t.shadowSm,
          },
          elevation2: {
            border: 'none',
            boxShadow: t.shadowMd,
          },
        },
      },
      // ── Button ────────────────────────────────────────────────
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            borderRadius: 10,
            padding: '7px 18px',
            fontWeight: 600,
            letterSpacing: '0.01em',
          },
          containedPrimary: {
            backgroundColor: t.primary,
            boxShadow: t.shadowPrimary,
            '&:hover': {
              backgroundColor: t.primaryDark,
              boxShadow: t.shadowPrimaryHover,
            },
          },
          outlinedPrimary: {
            borderColor: t.borderStrong,
            color: t.primary,
            '&:hover': {
              backgroundColor: t.primaryTint,
              borderColor: t.primary,
            },
          },
          textPrimary: {
            color: t.primary,
            '&:hover': { backgroundColor: t.primaryTint },
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            '&:hover': { backgroundColor: t.hoverOverlayStrong },
          },
        },
      },
      // ── Chip ─────────────────────────────────────────────────
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 999,
            fontWeight: 500,
            fontSize: '0.8125rem',
          },
          colorPrimary: {
            backgroundColor: t.chipPrimaryBg,
            color: t.chipPrimaryText,
          },
          colorSuccess: {
            backgroundColor: t.chipSuccessBg,
            color: t.chipSuccessText,
          },
          colorError: {
            backgroundColor: t.chipErrorBg,
            color: t.chipErrorText,
          },
          colorWarning: {
            backgroundColor: t.chipWarningBg,
            color: t.chipWarningText,
          },
        },
      },
      // ── Table ─────────────────────────────────────────────────
      MuiTableHead: {
        styleOverrides: {
          root: {
            '& .MuiTableCell-head': {
              backgroundColor: t.surfaceSubtle,
              color: t.textSecondary,
              fontWeight: 600,
              fontSize: '0.6875rem',   // 11px — design system Apr 2026
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              borderBottom: `1px solid ${t.border}`,
            },
          },
        },
      },
      MuiTableRow: {
        styleOverrides: {
          root: {
            '&:hover': {
              backgroundColor: t.rowHoverTint,
            },
            '&:last-child td': {
              borderBottom: 0,
            },
          },
        },
      },
      MuiTableCell: {
        styleOverrides: {
          root: {
            fontSize: '0.875rem',
            padding: '10px 16px',
            borderBottom: `1px solid ${t.borderLight}`,
            color: t.textPrimary,
          },
        },
      },
      // ── Drawer / Sidebar ──────────────────────────────────────
      MuiDrawer: {
        styleOverrides: {
          paper: {
            border: 'none',
            boxShadow: t.shadowMd,
          },
        },
      },
      // ── List ─────────────────────────────────────────────────
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            margin: '1px 8px',
            '&.Mui-selected': {
              backgroundColor: t.chipPrimaryBg,
              color: t.primary,
              '&:hover': { backgroundColor: t.primaryTintStrong },
            },
            '&:hover': { backgroundColor: t.hoverOverlay },
          },
        },
      },
      // ── Alert ─────────────────────────────────────────────────
      MuiAlert: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            fontSize: '0.875rem',
          },
          standardSuccess: {
            backgroundColor: t.alertSuccessBg,
            color: t.chipSuccessText,
          },
          standardError: {
            backgroundColor: t.alertErrorBg,
            color: t.chipErrorText,
          },
          standardWarning: {
            backgroundColor: t.alertWarningBg,
            color: t.chipWarningText,
          },
          standardInfo: {
            backgroundColor: t.alertInfoBg,
            color: t.infoDark,
          },
        },
      },
      // ── Tooltip ───────────────────────────────────────────────
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: {
            backgroundColor: t.tooltipBg,
            color: t.tooltipText,
            fontSize: '0.75rem',
            borderRadius: 8,
            padding: '5px 10px',
          },
          arrow: {
            color: t.tooltipBg,
          },
        },
      },
      // ── Dialog ────────────────────────────────────────────────
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 16,
            border: 'none',
            boxShadow: t.shadowLg,
          },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: {
            fontSize: '1.125rem',
            fontWeight: 600,
            color: t.textPrimary,
            paddingBottom: 8,
          },
        },
      },
      // ── Input / Form ─────────────────────────────────────────
      MuiTextField: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: {
          root: {
            margin: '0 !important',
            '& .MuiOutlinedInput-root': {
              minHeight: '48px',
              borderRadius: 10,
              backgroundColor: `${t.inputBg} !important`,
              transition: 'box-shadow 0.15s ease',
              '& input': {
                backgroundColor: `${t.inputBg} !important`,
                color: `${t.textPrimary} !important`,
                WebkitTextFillColor: `${t.textPrimary} !important`,
              },
              '& input::placeholder': {
                color: `${t.inputPlaceholder} !important`,
                opacity: 1,
              },
              '& fieldset': { borderColor: t.inputBorder },
              '&:hover fieldset': { borderColor: t.inputBorderHover },
              '&.Mui-focused': {
                boxShadow: `0 0 0 3px ${t.focusRing}`,
              },
              '&.Mui-focused fieldset': { borderColor: t.primary },
            },
            '& .MuiInputLabel-root': {
              color: t.textSecondary,
              '&.Mui-focused': { color: t.primary },
            },
            '& input[type="date"]::-webkit-calendar-picker-indicator': {
              cursor: 'pointer',
              filter: t.calendarIndicatorFilter,
            },
            '& input[type="time"]::-webkit-calendar-picker-indicator': {
              cursor: 'pointer',
              filter: t.calendarIndicatorFilter,
            },
          },
        },
      },
      MuiFormControl: {
        defaultProps: { variant: 'outlined' },
        styleOverrides: {
          root: { margin: '0 !important' },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            backgroundColor: `${t.inputBg} !important`,
            '& input': {
              backgroundColor: `${t.inputBg} !important`,
              color: `${t.textPrimary} !important`,
              WebkitTextFillColor: `${t.textPrimary} !important`,
            },
            '& input::placeholder': {
              color: `${t.inputPlaceholder} !important`,
              opacity: 1,
            },
            // Chrome paints its own autofill background; the inset shadow is
            // the only way to override it, and it has to follow the mode or
            // autofilled fields flash white on dark.
            '& input:-webkit-autofill': {
              WebkitBoxShadow: `0 0 0 1000px ${t.inputBg} inset !important`,
              WebkitTextFillColor: `${t.textPrimary} !important`,
            },
            '& input:-webkit-autofill:focus': {
              WebkitBoxShadow: `0 0 0 1000px ${t.inputBg} inset !important`,
              WebkitTextFillColor: `${t.textPrimary} !important`,
            },
          },
        },
      },
      // ── Select ────────────────────────────────────────────────
      MuiSelect: {
        styleOverrides: {
          root: {
            borderRadius: 10,
          },
        },
      },
      // ── Tabs ─────────────────────────────────────────────────
      MuiTab: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            fontSize: '0.875rem',
            minHeight: 48,
            color: t.textSecondary,
            '&.Mui-selected': { color: t.primary, fontWeight: 600 },
          },
        },
      },
      MuiTabs: {
        styleOverrides: {
          indicator: {
            backgroundColor: t.primary,
            height: 3,
            borderRadius: '3px 3px 0 0',
          },
        },
      },
      // ── Badge ─────────────────────────────────────────────────
      MuiBadge: {
        styleOverrides: {
          badge: {
            fontSize: '0.6875rem',
            fontWeight: 600,
            minWidth: 18,
            height: 18,
            padding: '0 4px',
          },
        },
      },
      // ── Divider ───────────────────────────────────────────────
      MuiDivider: {
        styleOverrides: {
          root: { borderColor: t.border },
        },
      },
    },
  });
};

/** Light theme, for callers rendering outside the colour-mode provider. */
export const muiTheme = createMipTheme('light');
