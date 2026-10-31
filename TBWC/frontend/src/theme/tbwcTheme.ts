import { createMaterialDesign3Theme, type ColorTokenOverrides } from '@meterit/framework-frontend/theme/materialDesign3Theme';

// TBWC brand accent: green. Everything else (error/warning/info/success,
// typography, shape, elevation, component overrides) inherits from the
// framework's base MD3 theme.
const tbwcGreenAccent: ColorTokenOverrides = {
  primary: '#2E7D32',
  onPrimary: '#FFFFFF',
  primaryContainer: '#C8E6C9',
  onPrimaryContainer: '#1B5E20',
  secondary: '#54785B',
  onSecondary: '#FFFFFF',
  secondaryContainer: '#D7E8D2',
  onSecondaryContainer: '#132A17',
};

/**
 * Build the TBWC theme for a colour mode. The green accent is the only
 * brand override; everything else comes from the framework's MD3 base, which
 * already ships a dark token set.
 */
export const createTbwcTheme = (mode: 'light' | 'dark' = 'light') =>
  createMaterialDesign3Theme(mode, tbwcGreenAccent);

/** Light theme, kept for callers that render outside the colour-mode provider. */
export const tbwcTheme = createTbwcTheme('light');
