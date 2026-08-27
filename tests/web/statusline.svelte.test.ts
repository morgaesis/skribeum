import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it } from "vitest";
import Statusline from "../../src/lib/Statusline.svelte";
import { STRINGS } from "../../src/lib/strings";

function render(update: unknown) {
  const target = document.createElement("div");
  document.body.append(target);
  const component = mount(Statusline, {
    target,
    props: { path: "note.md", update } as never,
  });
  flushSync();
  return {
    target,
    stop: () => {
      void unmount(component);
      target.remove();
    },
  };
}

describe("the status line's update affordance", () => {
  it("stays absent when there is nothing to act on", () => {
    const { target, stop } = render(null);
    expect(
      target.querySelector('[data-testid="statusline-update"]'),
    ).toBeNull();
    stop();
  });

  it("names the version and takes the accent, not the danger colour", () => {
    const { target, stop } = render({
      label: STRINGS.statuslineUpdateAvailable,
      version: "0.0.13",
      tooltip: STRINGS.statuslineUpdateTooltip,
    });
    const button = target.querySelector<HTMLElement>(
      '[data-testid="statusline-update"]',
    );
    expect(button?.textContent?.replace(/\s+/gu, " ").trim()).toBe(
      `${STRINGS.statuslineUpdateAvailable} 0.0.13`,
    );
    // It carries the update class rather than the danger class a failed
    // save takes: an available update is news, not a fault. The colour that
    // class resolves to is asserted against the deployed artifact, since a
    // rule that stopped applying would still satisfy a class-name check.
    expect(button?.classList.contains("skr-statusline-update")).toBe(true);
    expect(button?.classList.contains("skr-statusline-danger")).toBe(false);
    stop();
  });
});
