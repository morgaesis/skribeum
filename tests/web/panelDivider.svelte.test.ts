import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import PanelDivider from "../../src/lib/PanelDivider.svelte";

function pointerEvent(type: string, clientX: number): Event {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX });
  Object.defineProperty(event, "pointerId", { value: 7 });
  return event;
}

describe("panel divider", () => {
  it("tracks pointer geometry, stops at bounds, resets, and resizes by keyboard", async () => {
    document.documentElement.style.fontSize = "16px";
    const values: number[] = [];
    let collapsed = 0;
    const component = mount(PanelDivider, {
      target: document.body,
      props: {
        value: 16,
        minimum: 12,
        maximum: 24,
        defaultValue: 16,
        edge: "right",
        label: "Resize sidebar",
        onResize: (value: number) => values.push(value),
        onCollapse: () => {
          collapsed += 1;
        },
      },
    });
    flushSync();
    const divider = document.querySelector<HTMLElement>('[role="separator"]');
    expect(divider).not.toBeNull();
    if (divider === null) return;
    divider.setPointerCapture = () => {};
    divider.releasePointerCapture = () => {};
    divider.hasPointerCapture = () => false;

    divider.dispatchEvent(pointerEvent("pointerdown", 100));
    divider.dispatchEvent(pointerEvent("pointermove", 260));
    divider.dispatchEvent(pointerEvent("pointerup", 260));
    expect(values.at(-1)).toBe(24);

    divider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    expect(values.at(-1)).toBe(16);
    divider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
    );
    expect(values.at(-1)).toBe(15);
    divider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
    );
    expect(values.at(-1)).toBe(12);
    divider.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    expect(collapsed).toBe(1);

    await unmount(component);
  });
});
