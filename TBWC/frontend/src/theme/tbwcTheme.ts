import { createMaterialDesign3Theme, type ColorTokenOverrides } from '@framework/theme/materialDesign3Theme';

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

export const tbwcTheme = createMaterialDesign3Theme('light', tbwcGreenAccent);
