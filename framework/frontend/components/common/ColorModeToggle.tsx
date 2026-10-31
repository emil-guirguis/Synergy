import React from 'react';
import { useColorMode, type ColorModePreference } from '../../theme/ColorModeContext';
import { getIconElement } from '../../utils/iconHelper';
import './ColorModeToggle.css';

/** Icon and wording per preference, including 'system' as its own state. */
const FACES: Record<ColorModePreference, { icon: string; label: string }> = {
  light: { icon: 'light_mode', label: 'Light' },
  dark: { icon: 'dark_mode', label: 'Dark' },
  system: { icon: 'contrast', label: 'System' },
};

const NEXT: Record<ColorModePreference, ColorModePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

interface ColorModeToggleProps {
  /** Show the mode name next to the icon. Off by default — the header is tight. */
  showLabel?: boolean;
  className?: string;
}

/**
 * Cycles light -> dark -> follow the OS.
 *
 * 'system' is a visible third state rather than a hidden default, so someone
 * who wants the OS to keep deciding can get back to that after trying the
 * other two.
 */
export const ColorModeToggle: React.FC<ColorModeToggleProps> = ({
  showLabel = false,
  className,
}) => {
  const { preference, cycleMode } = useColorMode();
  const face = FACES[preference];
  const next = FACES[NEXT[preference]];

  return (
    <button
      type="button"
      className={`color-mode-toggle ${className || ''}`.trim()}
      onClick={cycleMode}
      aria-label={`Colour mode: ${face.label}. Switch to ${next.label}.`}
      title={`${face.label} — switch to ${next.label}`}
    >
      {getIconElement(face.icon, 'color-mode-toggle__icon')}
      {showLabel && <span className="color-mode-toggle__label">{face.label}</span>}
    </button>
  );
};

export default ColorModeToggle;
