export const THEME_NAMES = ["system", "light", "dark"] as const;
export const LIGHT_PALETTE_NAMES = ["manuscript", "studio", "gazette"] as const;
export const DARK_PALETTE_NAMES = ["lamplight", "graphite", "signal"] as const;
export const PROSE_FONT_NAMES = ["serif", "sans"] as const;
export const CODE_FONT_NAMES = ["modern", "classic"] as const;

export type ThemeName = (typeof THEME_NAMES)[number];
export type LightPaletteName = (typeof LIGHT_PALETTE_NAMES)[number];
export type DarkPaletteName = (typeof DARK_PALETTE_NAMES)[number];
export type ProseFontName = (typeof PROSE_FONT_NAMES)[number];
export type CodeFontName = (typeof CODE_FONT_NAMES)[number];

export type AppearancePreferences = {
  theme: ThemeName;
  light_palette: LightPaletteName;
  dark_palette: DarkPaletteName;
  prose_font: ProseFontName;
  code_font: CodeFontName;
  animations: boolean;
};

const themeSwitchGenerations = new WeakMap<HTMLElement, number>();

export function isThemeName(value: string): value is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

export function isLightPaletteName(value: string): value is LightPaletteName {
  return (LIGHT_PALETTE_NAMES as readonly string[]).includes(value);
}

export function isDarkPaletteName(value: string): value is DarkPaletteName {
  return (DARK_PALETTE_NAMES as readonly string[]).includes(value);
}

export function isProseFontName(value: string): value is ProseFontName {
  return (PROSE_FONT_NAMES as readonly string[]).includes(value);
}

export function isCodeFontName(value: string): value is CodeFontName {
  return (CODE_FONT_NAMES as readonly string[]).includes(value);
}

/** Applies persisted colors. System color changes remain CSS-driven. */
export function applyTheme(
  theme: ThemeName,
  lightPalette: LightPaletteName = "manuscript",
  darkPalette: DarkPaletteName = "lamplight",
  root = document.documentElement,
) {
  const generation = (themeSwitchGenerations.get(root) ?? 0) + 1;
  themeSwitchGenerations.set(root, generation);
  root.dataset.themeSwitching = "true";
  root.dataset.theme = theme;
  root.dataset.lightPalette = lightPalette;
  root.dataset.darkPalette = darkPalette;
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
  const ownerWindow = root.ownerDocument.defaultView;
  if (ownerWindow === null) {
    delete root.dataset.themeSwitching;
    return;
  }
  ownerWindow.requestAnimationFrame(() => {
    ownerWindow.requestAnimationFrame(() => {
      if (themeSwitchGenerations.get(root) === generation) {
        delete root.dataset.themeSwitching;
      }
    });
  });
}

export function applyProseFont(
  proseFont: ProseFontName,
  root = document.documentElement,
) {
  root.dataset.proseFont = proseFont;
}

export function applyCodeFont(
  codeFont: CodeFontName,
  root = document.documentElement,
) {
  root.dataset.codeFont = codeFont;
}

export function applyAnimations(
  animations: boolean,
  root = document.documentElement,
) {
  root.dataset.animations = String(animations);
}

export function applyAppearance(
  preferences: AppearancePreferences,
  root = document.documentElement,
) {
  applyTheme(
    preferences.theme,
    preferences.light_palette,
    preferences.dark_palette,
    root,
  );
  applyProseFont(preferences.prose_font, root);
  applyCodeFont(preferences.code_font, root);
  applyAnimations(preferences.animations, root);
}
