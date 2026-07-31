export const THEME_NAMES = ["system", "light", "dark"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** Applies the persisted preference. System color changes remain CSS-driven. */
export function applyTheme(theme: ThemeName, root = document.documentElement) {
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
}
