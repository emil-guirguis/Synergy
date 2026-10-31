/**
 * Material Design 3 Theme Module
 * Exports all theme-related utilities and configurations
 */

export { createMaterialDesign3Theme, lightTheme, darkTheme } from './materialDesign3Theme';
export {
  ColorModeProvider,
  useColorMode,
  type ColorModePreference,
  type ResolvedColorMode,
} from './ColorModeContext';
export { lightColorTokens, darkColorTokens, type ColorTokens } from './colors';
export { typographyScales, fontFamily, type TypographyVariant } from './typography';
export { spacingScale, spacingAliases, spacing } from './spacing';
export { elevationShadows, getElevationShadow, type ElevationSystem } from './elevation';
