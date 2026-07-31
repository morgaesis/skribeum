import { describe, expect, it } from "vitest";
import { renderMath } from "../../src/lib/rendering/math";

describe("math rendering", () => {
  it("renders local KaTeX HTML and MathML", () => {
    const host = document.createElement("span");
    expect(renderMath(host, "a^2 + b^2 = c^2", false)).toBe(true);
    expect(host.querySelector(".katex-html")).not.toBeNull();
    expect(host.querySelector("math")).not.toBeNull();
  });

  it("shows malformed source as an error and never throws", () => {
    const host = document.createElement("span");
    expect(renderMath(host, "\\frac{", false)).toBe(false);
    expect(host.textContent).toBe("\\frac{");
    expect(host.classList.contains("cm-skr-render-error")).toBe(true);
    expect(host.getAttribute("role")).toBe("alert");
  });
});
