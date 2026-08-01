export const THEME_NAMES = ["system", "light", "dark"] as const;
export const LIGHT_PALETTE_NAMES = ["manuscript", "studio", "gazette"] as const;
export const DARK_PALETTE_NAMES = ["lamplight", "graphite", "signal"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];
export type LightPaletteName = (typeof LIGHT_PALETTE_NAMES)[number];
export type DarkPaletteName = (typeof DARK_PALETTE_NAMES)[number];

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

export function isLightPaletteName(value: string): value is LightPaletteName {
  return (LIGHT_PALETTE_NAMES as readonly string[]).includes(value);
}

export function isDarkPaletteName(value: string): value is DarkPaletteName {
  return (DARK_PALETTE_NAMES as readonly string[]).includes(value);
}

/** Applies the persisted preference. System color changes remain CSS-driven. */
export function applyTheme(
  theme: ThemeName,
  lightPalette: LightPaletteName = "manuscript",
  darkPalette: DarkPaletteName = "lamplight",
  root = document.documentElement,
) {
  root.dataset.theme = theme;
  root.dataset.lightPalette = lightPalette;
  root.dataset.darkPalette = darkPalette;
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
}
