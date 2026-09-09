/**
 * Material Design 3 Theme Configuration
 * Creates MUI theme with Material Design 3 tokens
 */

import { createTheme, darken, type ThemeOptions } from '@mui/material/styles';
import { lightColorTokens, darkColorTokens, type ColorTokens } from './colors';
import { typographyScales, fontFamily } from './typography';
import { elevationShadows } from './elevation';

/**
 * Base MD3 token set, per app, for the accent slots (primary/secondary) an app
 * may override. Apps inherit every other token (error/warning/info/success,
 * typography, shape, elevation, component overrides) from this file.
 */
export type ColorTokenOverrides = Partial<
  Pick<
    ColorTokens,
    | 'primary'
    | 'onPrimary'
    | 'primaryContainer'
    | 'onPrimaryContainer'
    | 'secondary'
    | 'onSecondary'
    | 'secondaryContainer'
    | 'onSecondaryContainer'
  >
>;

/**
 * Create Material Design 3 theme for light mode
 */
export const createLightTheme = (colorOverrides?: ColorTokenOverrides): ReturnType<typeof createTheme> => {
  const lightColorTokensMerged = { ...lightColorTokens, ...colorOverrides };
  const themeOptions: ThemeOptions = {
    palette: {
      mode: 'light',
      primary: {
        main: lightColorTokensMerged.primary,
        light: lightColorTokensMerged.primaryContainer,
        dark: colorOverrides?.primary ? darken(lightColorTokensMerged.primary, 0.2) : '#4F378B',
        contrastText: lightColorTokensMerged.onPrimary,
      },
      secondary: {
        main: lightColorTokensMerged.secondary,
        light: lightColorTokensMerged.secondaryContainer,
        dark: colorOverrides?.secondary ? darken(lightColorTokensMerged.secondary, 0.2) : '#4A4458',
        contrastText: lightColorTokensMerged.onSecondary,
      },
      error: {
        main: lightColorTokens.error,
        light: lightColorTokens.errorContainer,
        dark: '#8C1D18',
        contrastText: lightColorTokens.onError,
      },
      warning: {
        main: lightColorTokens.warning,
        light: lightColorTokens.warningContainer,
        dark: '#BF360C',
        contrastText: lightColorTokens.onWarning,
      },
      info: {
        main: lightColorTokens.info,
        light: lightColorTokens.infoContainer,
        dark: '#0277BD',
        contrastText: lightColorTokens.onInfo,
      },
      success: {
        main: lightColorTokens.success,
        light: lightColorTokens.successContainer,
        dark: '#1B5E20',
        contrastText: lightColorTokens.onSuccess,
      },
      background: {
        default: lightColorTokens.background,
        paper: lightColorTokens.surface,
      },
      divider: lightColorTokens.outline,
    },
    typography: {
      fontFamily,
      displayLarge: typographyScales.displayLarge,
      displayMedium: typographyScales.displayMedium,
      displaySmall: typographyScales.displaySmall,
      headlineLarge: typographyScales.headlineLarge,
      headlineMedium: typographyScales.headlineMedium,
      headlineSmall: typographyScales.headlineSmall,
      titleLarge: typographyScales.titleLarge,
      titleMedium: typographyScales.titleMedium,
      titleSmall: typographyScales.titleSmall,
      bodyLarge: typographyScales.bodyLarge,
      bodyMedium: typographyScales.bodyMedium,
      bodySmall: typographyScales.bodySmall,
      labelLarge: typographyScales.labelLarge,
      labelMedium: typographyScales.labelMedium,
      labelSmall: typographyScales.labelSmall,
    } as any,
    shape: {
      borderRadius: 12,
    },
    shadows: [
      'none',
      elevationShadows.level1,
      elevationShadows.level2,
      elevationShadows.level3,
      elevationShadows.level4,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
    ],
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            borderRadius: 24,
            padding: '10px 24px',
            transition: 'all 200ms ease-in-out',
          },
          contained: {
            boxShadow: elevationShadows.level1,
            '&:hover': {
              boxShadow: elevationShadows.level2,
            },
          },
          outlined: {
            borderColor: lightColorTokens.outline,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            boxShadow: elevationShadows.level1,
            padding: 16,
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 8,
            },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 28,
            boxShadow: elevationShadows.level3,
          },
        },
      },
    },
  };

  return createTheme(themeOptions);
};

/**
 * Create Material Design 3 theme for dark mode
 */
export const createDarkTheme = (colorOverrides?: ColorTokenOverrides): ReturnType<typeof createTheme> => {
  const darkColorTokensMerged = { ...darkColorTokens, ...colorOverrides };
  const themeOptions: ThemeOptions = {
    palette: {
      mode: 'dark',
      primary: {
        main: darkColorTokensMerged.primary,
        light: darkColorTokensMerged.primaryContainer,
        dark: colorOverrides?.primary ? darken(darkColorTokensMerged.primary, 0.2) : '#371E55',
        contrastText: darkColorTokensMerged.onPrimary,
      },
      secondary: {
        main: darkColorTokensMerged.secondary,
        light: darkColorTokensMerged.secondaryContainer,
        dark: colorOverrides?.secondary ? darken(darkColorTokensMerged.secondary, 0.2) : '#332D41',
        contrastText: darkColorTokensMerged.onSecondary,
      },
      error: {
        main: darkColorTokens.error,
        light: darkColorTokens.errorContainer,
        dark: '#601410',
        contrastText: darkColorTokens.onError,
      },
      warning: {
        main: darkColorTokens.warning,
        light: darkColorTokens.warningContainer,
        dark: '#E65100',
        contrastText: darkColorTokens.onWarning,
      },
      info: {
        main: darkColorTokens.info,
        light: darkColorTokens.infoContainer,
        dark: '#003DA5',
        contrastText: darkColorTokens.onInfo,
      },
      success: {
        main: darkColorTokens.success,
        light: darkColorTokens.successContainer,
        dark: '#1B5E20',
        contrastText: darkColorTokens.onSuccess,
      },
      background: {
        default: darkColorTokens.background,
        paper: darkColorTokens.surface,
      },
      divider: darkColorTokens.outline,
    },
    typography: {
      fontFamily,
      displayLarge: typographyScales.displayLarge,
      displayMedium: typographyScales.displayMedium,
      displaySmall: typographyScales.displaySmall,
      headlineLarge: typographyScales.headlineLarge,
      headlineMedium: typographyScales.headlineMedium,
      headlineSmall: typographyScales.headlineSmall,
      titleLarge: typographyScales.titleLarge,
      titleMedium: typographyScales.titleMedium,
      titleSmall: typographyScales.titleSmall,
      bodyLarge: typographyScales.bodyLarge,
      bodyMedium: typographyScales.bodyMedium,
      bodySmall: typographyScales.bodySmall,
      labelLarge: typographyScales.labelLarge,
      labelMedium: typographyScales.labelMedium,
      labelSmall: typographyScales.labelSmall,
    } as any,
    shape: {
      borderRadius: 12,
    },
    shadows: [
      'none',
      elevationShadows.level1,
      elevationShadows.level2,
      elevationShadows.level3,
      elevationShadows.level4,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
      elevationShadows.level5,
    ],
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            fontWeight: 500,
            borderRadius: 24,
            padding: '10px 24px',
            transition: 'all 200ms ease-in-out',
          },
          contained: {
            boxShadow: elevationShadows.level1,
            '&:hover': {
              boxShadow: elevationShadows.level2,
            },
          },
          outlined: {
            borderColor: darkColorTokens.outline,
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: 12,
            boxShadow: elevationShadows.level1,
            padding: 16,
          },
        },
      },
      MuiTextField: {
        styleOverrides: {
          root: {
            '& .MuiOutlinedInput-root': {
              borderRadius: 8,
            },
          },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: 28,
            boxShadow: elevationShadows.level3,
          },
        },
      },
    },
  };

  return createTheme(themeOptions);
};

// Export pre-configured themes
export const lightTheme = createLightTheme();
export const darkTheme = createDarkTheme();

/**
 * Create Material Design 3 theme with optional mode
 */
export const createMaterialDesign3Theme = (
  mode: 'light' | 'dark' = 'light',
  colorOverrides?: ColorTokenOverrides
) => {
  return mode === 'light' ? createLightTheme(colorOverrides) : createDarkTheme(colorOverrides);
};
