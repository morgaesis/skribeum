import { flushSync, mount, tick, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import StartupVaultRecovery from "../../src/lib/StartupVaultRecovery.svelte";
import {
  emptyStartupSurface,
  failedStartupSurface,
  isStaleVaultOpenError,
  nextStartupDecision,
  selectedStartupFailureSurface,
  staleChooserStartupDecision,
  startupSource,
  type VaultStartupSession,
} from "../../src/lib/startupVaultRecovery";
import StartupVaultRecoveryHarness from "./StartupVaultRecoveryHarness.svelte";

const emptySession: VaultStartupSession = {
  schema_version: 1,
  last_vault: null,
  recent_vaults: [],
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("startup vault recovery decisions", () => {
  it("keeps browser and demo launches out of native session recovery", () => {
    expect(startupSource({ desktop: false })).toEqual({ kind: "browser" });
    expect(startupSource({ desktop: true, webdriverVault: "/e2e" })).toEqual({
      kind: "webdriver",
      path: "/e2e",
    });
    expect(startupSource({ desktop: true, nativeOpenPending: true })).toEqual({
      kind: "native",
    });
  });

  it("gives an explicit WebDriver vault and native file open precedence", () => {
    expect(
      startupSource({
        desktop: true,
        webdriverVault: "/e2e",
        nativeOpenPending: true,
      }),
    ).toEqual({ kind: "webdriver", path: "/e2e" });
    expect(startupSource({ desktop: true, nativeOpenPending: true })).toEqual({
      kind: "native",
    });
  });

  it("keeps an empty session at the existing Open vault state", () => {
    expect(nextStartupDecision(emptySession)).toEqual({
      kind: "surface",
      surface: emptyStartupSurface(),
    });
  });

  it("opens the sole recent vault automatically", () => {
    expect(
      nextStartupDecision({ ...emptySession, recent_vaults: ["/vaults/only"] }),
    ).toEqual({ kind: "open", path: "/vaults/only" });
  });

  it("uses a valid last vault authoritatively ahead of newer recents", () => {
    expect(
      nextStartupDecision({
        ...emptySession,
        last_vault: "/vaults/last",
        recent_vaults: ["/vaults/newer", "/vaults/last"],
      }),
    ).toEqual({ kind: "open", path: "/vaults/last" });
  });

  it("renders multiple recents in newest-first order and disambiguates duplicate names", () => {
    const decision = nextStartupDecision({
      ...emptySession,
      recent_vaults: [
        "/work/alpha/Notes",
        "/work/beta/Notes",
        "/work/archive/Journal",
      ],
    });
    expect(decision.kind).toBe("surface");
    if (decision.kind !== "surface" || decision.surface.kind !== "chooser")
      return;
    expect(decision.surface.rows.map((row) => row.path)).toEqual([
      "/work/alpha/Notes",
      "/work/beta/Notes",
      "/work/archive/Journal",
    ]);
    expect(decision.surface.rows.map((row) => row.label)).toEqual([
      "Notes, /work/alpha/Notes",
      "Notes, /work/beta/Notes",
      "Journal",
    ]);
    expect(decision.surface.rows[0]?.accessibleLabel).toBe(
      "Open vault /work/alpha/Notes",
    );
  });

  it("reapplies recents after the native stale-path forget result", () => {
    expect(
      nextStartupDecision({
        ...emptySession,
        recent_vaults: ["/vaults/fallback"],
      }),
    ).toEqual({ kind: "open", path: "/vaults/fallback" });
    expect(nextStartupDecision(emptySession)).toEqual({
      kind: "surface",
      surface: emptyStartupSurface(),
    });
  });

  it("removes a stale chooser choice and auto-opens only a sole remaining recent vault", () => {
    expect(
      staleChooserStartupDecision({
        ...emptySession,
        last_vault: "/vaults/ignored-last",
        recent_vaults: ["/vaults/newest", "/vaults/older"],
      }),
    ).toMatchObject({
      kind: "surface",
      surface: { kind: "chooser" },
    });
    expect(
      staleChooserStartupDecision({
        ...emptySession,
        last_vault: "/vaults/ignored-last",
        recent_vaults: ["/vaults/only"],
      }),
    ).toEqual({ kind: "open", path: "/vaults/only" });
  });

  it("preserves non-stale failures in a chooser with a browse action", () => {
    expect(isStaleVaultOpenError("vault/not-found")).toBe(true);
    expect(isStaleVaultOpenError("vault/not-a-directory")).toBe(true);
    expect(isStaleVaultOpenError("fs/permission-denied")).toBe(false);
    const surface = failedStartupSurface(
      {
        ...emptySession,
        last_vault: "/vaults/locked",
        recent_vaults: ["/vaults/locked"],
      },
      "/vaults/locked",
      "Opening the vault failed: permission denied",
    );
    expect(surface).toMatchObject({
      kind: "chooser",
      error: "Opening the vault failed: permission denied",
    });
    if (surface.kind !== "chooser") return;
    expect(surface.rows.map((row) => row.path)).toEqual(["/vaults/locked"]);
  });

  it("keeps every chooser row after a non-stale explicit selection failure", () => {
    const surface = selectedStartupFailureSurface(
      {
        kind: "chooser",
        rows: [
          {
            path: "/vaults/newest",
            label: "newest",
            accessibleLabel: "Open vault /vaults/newest",
          },
          {
            path: "/vaults/older",
            label: "older",
            accessibleLabel: "Open vault /vaults/older",
          },
        ],
      },
      "/vaults/newest",
      "Opening the vault failed: permission denied",
    );
    expect(surface).toMatchObject({
      kind: "chooser",
      error: "Opening the vault failed: permission denied",
    });
    if (surface.kind !== "chooser") return;
    expect(surface.rows.map((row) => row.path)).toEqual([
      "/vaults/newest",
      "/vaults/older",
    ]);
  });
});

describe("startup vault recovery surface", () => {
  it("holds a stable pending surface instead of flashing Open vault", () => {
    const component = mount(StartupVaultRecovery, {
      target: document.body,
      props: { surface: { kind: "pending" }, onOpen: () => {} },
    });
    flushSync();
    expect(
      document.querySelector('[data-testid="startup-pending"]'),
    ).not.toBeNull();
    expect(document.querySelector('[data-command-id="vault.open"]')).toBeNull();
    void unmount(component);
  });

  it("focuses the first recent vault once when the chooser arrives", async () => {
    const surface = nextStartupDecision({
      ...emptySession,
      recent_vaults: ["/vaults/newest", "/vaults/older"],
    });
    if (surface.kind !== "surface") return;
    const component = mount(StartupVaultRecovery, {
      target: document.body,
      props: { surface: surface.surface, onOpen: () => {} },
    });
    flushSync();
    await tick();
    expect(
      [
        ...document.querySelectorAll<HTMLElement>("[data-startup-vault-path]"),
      ].map((row) => row.dataset.startupVaultPath),
    ).toEqual(["/vaults/newest", "/vaults/older"]);
    expect(
      document.querySelector('[data-command-id="vault.open"]'),
    ).not.toBeNull();
    expect(
      document.activeElement?.getAttribute("data-startup-vault-path"),
    ).toBe("/vaults/newest");
    await tick();
    expect(
      document.activeElement?.getAttribute("data-startup-vault-path"),
    ).toBe("/vaults/newest");
    void unmount(component);
  });

  it("focuses the Open vault action after an empty or stale recovery", async () => {
    const component = mount(StartupVaultRecovery, {
      target: document.body,
      props: { surface: emptyStartupSurface(), onOpen: () => {} },
    });
    flushSync();
    await tick();
    expect(document.activeElement?.getAttribute("data-command-id")).toBe(
      "vault.open",
    );
    void unmount(component);
  });

  it("moves focus to the newest remaining row when a stale chooser row is forgotten", async () => {
    const component = mount(StartupVaultRecoveryHarness, {
      target: document.body,
      props: {
        initialSurface: nextStartupDecision({
          ...emptySession,
          recent_vaults: ["/vaults/stale", "/vaults/newest", "/vaults/older"],
        }).surface,
      },
    });
    flushSync();
    await tick();

    component.setSurface(
      nextStartupDecision({
        ...emptySession,
        recent_vaults: ["/vaults/newest", "/vaults/older"],
      }).surface,
    );
    flushSync();
    await tick();
    await tick();

    expect(
      [
        ...document.querySelectorAll<HTMLElement>("[data-startup-vault-path]"),
      ].map((row) => row.dataset.startupVaultPath),
    ).toEqual(["/vaults/newest", "/vaults/older"]);
    expect(
      document.activeElement?.getAttribute("data-startup-vault-path"),
    ).toBe("/vaults/newest");
    void unmount(component);
  });
});
