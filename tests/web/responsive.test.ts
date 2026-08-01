import { describe, expect, it } from "vitest";
import {
  MINIMUM_TOUCH_TARGET_PX,
  NARROW_BREAKPOINT_PX,
  responsiveLayout,
} from "../../src/lib/responsive";

describe("responsive shell geometry", () => {
  it.each([
    [360, 312],
    [390, 342],
  ])(
    "uses overlay panels and preserves the reading width at %ipx",
    (width, expectedEditorWidth) => {
      const layout = responsiveLayout(width);
      expect(layout.panelPresentation).toBe("overlay");
      expect(layout.editorInlineSize).toBe(expectedEditorWidth);
      expect(layout.editorInlineSize).toBeGreaterThanOrEqual(width - 48);
      expect(layout.minimumTouchTarget).toBe(MINIMUM_TOUCH_TARGET_PX);
    },
  );

  it("keeps columns above the documented breakpoint", () => {
    expect(responsiveLayout(NARROW_BREAKPOINT_PX).panelPresentation).toBe(
      "overlay",
    );
    expect(responsiveLayout(NARROW_BREAKPOINT_PX + 1).panelPresentation).toBe(
      "column",
    );
  });
});
