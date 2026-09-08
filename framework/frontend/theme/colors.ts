/**
 * Material Design 3 Color Tokens
 * Defines semantic color values for light and dark themes
 */

// Default palette mirrors MeterItPro's existing indigo/violet theme
// (MeterItPro/frontend/src/theme/muiTheme.ts) so any app that doesn't
// supply its own ColorTokenOverrides inherits MIP's scheme, not raw MD3.
export const lightColorTokens = {
  // Primary Colors
  primary: '#4F46E5',
  onPrimary: '#FFFFFF',
  primaryContainer: '#818CF8',
  onPrimaryContainer: '#1E1B4B',

  // Secondary Colors
  secondary: '#7C3AED',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#A78BFA',
  onSecondaryContainer: '#2E1065',

  // Tertiary Colors
  tertiary: '#7D5260',
  onTertiary: '#FFFFFF',
  tertiaryContainer: '#FFD8E4',
  onTertiaryContainer: '#31111D',

  // Error Colors
  error: '#DC2626',
  onError: '#FFFFFF',
  errorContainer: '#F87171',
  onErrorContainer: '#7F1D1D',

  // Warning Colors
  warning: '#F59E0B',
  onWarning: '#FFFFFF',
  warningContainer: '#FBBF24',
  onWarningContainer: '#78350F',

  // Info Colors
  info: '#0EA5E9',
  onInfo: '#FFFFFF',
  infoContainer: '#7DD3FC',
  onInfoContainer: '#0C4A6E',

  // Success Colors
  success: '#16A34A',
  onSuccess: '#FFFFFF',
  successContainer: '#86EFAC',
  onSuccessContainer: '#14532D',

  // Neutral Colors
  background: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceVariant: '#F3F4F6',
  outline: '#E5E7EB',
  outlineVariant: '#D1D5DB',
};

export const darkColorTokens = {
  // Primary Colors
  primary: '#D0BCFF',
  onPrimary: '#371E55',
  primaryContainer: '#4F378B',
  onPrimaryContainer: '#EADDFF',

  // Secondary Colors
  secondary: '#CCC7DB',
  onSecondary: '#332D41',
  secondaryContainer: '#4A4458',
  onSecondaryContainer: '#E8DEF8',

  // Tertiary Colors
  tertiary: '#F4B1D3',
  onTertiary: '#492532',
  tertiaryContainer: '#633B48',
  onTertiaryContainer: '#FFD8E4',

  // Error Colors
  error: '#F2B8B5',
  onError: '#601410',
  errorContainer: '#8C1D18',
  onErrorContainer: '#F9DEDC',

  // Warning Colors
  warning: '#FFB74D',
  onWarning: '#E65100',
  warningContainer: '#BF360C',
  onWarningContainer: '#FFE0B2',

  // Info Colors
  info: '#81D4FA',
  onInfo: '#003DA5',
  infoContainer: '#0277BD',
  onInfoContainer: '#B3E5FC',

  // Success Colors
  success: '#A5D6A7',
  onSuccess: '#1B5E20',
  successContainer: '#2E7D32',
  onSuccessContainer: '#C8E6C9',

  // Neutral Colors
  background: '#1C1B1F',
  surface: '#1C1B1F',
  surfaceVariant: '#49454E',
  outline: '#938F99',
  outlineVariant: '#49454E',
};

export interface ColorTokens {
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  secondary: string;
  onSecondary: string;
  secondaryContainer: string;
  onSecondaryContainer: string;
  tertiary: string;
  onTertiary: string;
  tertiaryContainer: string;
  onTertiaryContainer: string;
  error: string;
  onError: string;
  errorContainer: string;
  onErrorContainer: string;
  warning: string;
  onWarning: string;
  warningContainer: string;
  onWarningContainer: string;
  info: string;
  onInfo: string;
  infoContainer: string;
  onInfoContainer: string;
  success: string;
  onSuccess: string;
  successContainer: string;
  onSuccessContainer: string;
  background: string;
  surface: string;
  surfaceVariant: string;
  outline: string;
  outlineVariant: string;
}
