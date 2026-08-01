export const NARROW_BREAKPOINT_PX = 960;
export const NARROW_BREAKPOINT_REM = 60;
export const MINIMUM_TOUCH_TARGET_PX = 44;
export const MINIMUM_EDITOR_GUTTER_PX = 24;

export type ResponsiveLayout = {
  panelPresentation: "column" | "overlay";
  editorInlineSize: number;
  minimumTouchTarget: number;
};

/** The shell geometry shared by runtime viewport handling and regression tests. */
export function responsiveLayout(viewportWidth: number): ResponsiveLayout {
  const narrow = viewportWidth <= NARROW_BREAKPOINT_PX;
  return {
    panelPresentation: narrow ? "overlay" : "column",
    editorInlineSize: narrow
      ? Math.max(0, viewportWidth - MINIMUM_EDITOR_GUTTER_PX * 2)
      : viewportWidth,
    minimumTouchTarget: MINIMUM_TOUCH_TARGET_PX,
  };
}
