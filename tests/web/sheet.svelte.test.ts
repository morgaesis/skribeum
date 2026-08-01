import { flushSync, mount, tick, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
import Sheet from "../../src/lib/Sheet.svelte";

describe("overlay sheet focus", () => {
  it("traps focus, dismisses with Escape, and restores its opener", async () => {
    const opener = document.createElement("button");
    opener.textContent = "Open";
    document.body.append(opener);
    opener.focus();
    const onClose = vi.fn();
    const component = mount(Sheet, {
      target: document.body,
      props: { label: "Test sheet", onClose },
    });
    flushSync();
    await tick();

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const close = dialog?.querySelector<HTMLButtonElement>("button");
    expect(dialog?.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(close);

    close?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(close);
    close?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(document.activeElement).toBe(close);

    close?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    await unmount(component);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
