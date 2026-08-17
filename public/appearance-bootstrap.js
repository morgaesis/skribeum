// Restores the persisted appearance onto the document before the first paint.
//
// The settings document is read asynchronously, so the shell would otherwise
// paint its default palette for the length of that read and then swap. This
// script is classic and parser-blocking on purpose: a module script is
// deferred, which puts it after the first frame, and an inline script is
// refused by the content security policy. It reads the mirror that
// `applyAppearance` writes and touches nothing else; the settings read that
// follows confirms what is already on screen.
//
// Kept in step with `src/lib/themes/theme.ts` by the appearance suite, which
// compares the storage key and the accepted names across both files.
(() => {
  const MIRROR = "skribeum.appearance.v1";
  const THEMES = ["system", "light", "dark"];
  const LIGHT_PALETTES = ["manuscript", "studio", "gazette"];
  const DARK_PALETTES = ["nightroom", "graphite", "signal"];
  const PROSE_FONTS = ["serif", "sans"];
  const CODE_FONTS = ["modern", "classic"];

  const pick = (value, allowed) =>
    allowed.includes(value) ? value : allowed[0];

  let stored = null;
  try {
    stored = window.localStorage.getItem(MIRROR);
  } catch {
    return;
  }
  if (stored === null) return;

  let appearance = null;
  try {
    appearance = JSON.parse(stored);
  } catch {
    return;
  }
  if (typeof appearance !== "object" || appearance === null) return;

  const root = document.documentElement;
  const theme = pick(appearance.theme, THEMES);
  root.dataset.theme = theme;
  root.dataset.lightPalette = pick(appearance.light_palette, LIGHT_PALETTES);
  root.dataset.darkPalette = pick(appearance.dark_palette, DARK_PALETTES);
  root.dataset.proseFont = pick(appearance.prose_font, PROSE_FONTS);
  root.dataset.codeFont = pick(appearance.code_font, CODE_FONTS);
  root.dataset.animations = String(appearance.animations !== false);
  root.style.colorScheme = theme === "system" ? "light dark" : theme;
})();
