import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRINGS } from "../../src/lib/strings";
import { reactiveState } from "./helpers/reactiveState.svelte";
import SurfaceBoundaryHarness from "./SurfaceBoundaryHarness.svelte";

/**
 * An error thrown while Svelte updates a component destroys every effect
 * above it that cannot handle it. Unbounded, that is the whole application:
 * one panel's failure leaves the shell rendered but inert, with no further
 * updates and no way back. These tests hold the containment property by
 * driving the rest of the shell after a panel has failed.
 */
describe("a panel that fails inside an update", () => {
  let reported: unknown[][] = [];

  beforeEach(() => {
    reported = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      reported.push(args);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });

  function elsewhere(): HTMLButtonElement | null {
    return document.querySelector<HTMLButtonElement>(
      '[data-testid="elsewhere"]',
    );
  }

  it("takes down its own surface and leaves the rest of the shell live", async () => {
    const props = reactiveState<{ label: string; shouldFail: boolean }>({
      label: "Vault",
      shouldFail: false,
    });
    const component = mount(SurfaceBoundaryHarness, {
      target: document.body,
      props,
    });
    flushSync();

    expect(document.querySelector('[data-testid="panel"]')?.textContent).toBe(
      "false",
    );
    elsewhere()?.click();
    await tick();
    expect(elsewhere()?.textContent?.trim()).toBe("1");

    props.shouldFail = true;
    flushSync();
    await tick();

    // The panel is gone and says so where it used to be.
    expect(document.querySelector('[data-testid="panel"]')).toBeNull();
    const failure = document.querySelector<HTMLElement>('[role="alert"]');
    expect(failure).not.toBeNull();
    expect(failure?.textContent).toContain(STRINGS.couldNotLoad);
    expect(failure?.dataset.surfaceFailure).toBe("Vault");
    expect(reported).toHaveLength(1);

    // The rest of the shell still renders on interaction, which is the
    // property the unbounded failure destroyed.
    elsewhere()?.click();
    await tick();
    expect(elsewhere()?.textContent?.trim()).toBe("2");
    elsewhere()?.click();
    await tick();
    expect(elsewhere()?.textContent?.trim()).toBe("3");

    await unmount(component);
  });

  it("rebuilds the surface when the reader asks it to", async () => {
    const props = reactiveState<{ label: string; shouldFail: boolean }>({
      label: "Vault",
      shouldFail: true,
    });
    const component = mount(SurfaceBoundaryHarness, {
      target: document.body,
      props,
    });
    flushSync();
    await tick();
    expect(document.querySelector('[data-testid="panel"]')).toBeNull();

    const retry = [
      ...document.querySelectorAll<HTMLButtonElement>("button"),
    ].find((button) => button.textContent?.trim() === STRINGS.retryAction);
    expect(retry).toBeDefined();

    props.shouldFail = false;
    flushSync();
    retry?.click();
    flushSync();
    await tick();

    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.querySelector('[data-testid="panel"]')?.textContent).toBe(
      "false",
    );

    await unmount(component);
  });
});
