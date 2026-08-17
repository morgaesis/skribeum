import { $, $$, browser, expect } from "@wdio/globals";

function startupPath(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`${name} is required by the startup-vault E2E mode`);
  }
  return value;
}

const FIRST_VAULT_PATH = startupPath("SKRIBEUM_E2E_STARTUP_VAULT_FIRST");
const SECOND_VAULT_PATH = startupPath("SKRIBEUM_E2E_STARTUP_VAULT_SECOND");

type VaultSession = {
  schema_version: number;
  last_vault: string | null;
  recent_vaults: string[];
};

/** Switches once, then waits for the fresh webview's Tauri bridge. */
async function waitForPackagedMainWindow(): Promise<void> {
  await browser.tauri.switchWindow("main");
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          document.readyState !== "loading" &&
          typeof (
            window as Window & {
              __TAURI__?: { core?: { invoke?: unknown } };
            }
          ).__TAURI__?.core?.invoke === "function",
      ),
    {
      timeout: 30000,
      interval: 100,
      timeoutMsg: "the packaged Tauri bridge did not become callable",
    },
  );
}

/** The embedded provider needs executeAsync for promise-returning Tauri IPC. */
async function invokeTauriCommand<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const result = await browser.executeAsync<
    T | string,
    [string, Record<string, unknown> | undefined]
  >(
    (name, payload, done) => {
      const tauri = (
        window as Window & {
          __TAURI__?: {
            core?: { invoke(name: string, args?: unknown): Promise<unknown> };
          };
        }
      ).__TAURI__;
      if (tauri?.core?.invoke === undefined) {
        done("no-global-tauri");
        return;
      }
      void tauri.core.invoke(name, payload).then(
        (value) => done(value as T),
        (error: unknown) => done(`Tauri IPC ${name} failed: ${String(error)}`),
      );
    },
    command,
    args,
  );
  if (typeof result === "string") throw new Error(result);
  return result;
}

async function readSession(): Promise<VaultSession> {
  return invokeTauriCommand<VaultSession>("vault_session_read");
}

async function recordVault(path: string): Promise<void> {
  await invokeTauriCommand("vault_open", { path });
}

async function relaunch(): Promise<void> {
  await browser.reloadSession();
  await waitForPackagedMainWindow();
  // reloadSession reconnects to the embedded Tauri process. Refresh the
  // webview only after that bridge is ready so App's startup path runs from
  // a new frontend lifetime instead of racing switchWindow's Tauri-core probe.
  await browser.refresh();
  await waitForPackagedMainWindow();
}

async function waitForStartupSurface(kind: "empty" | "chooser"): Promise<void> {
  await $(`[data-startup-vault-surface="${kind}"]`).waitForExist({
    timeout: 15000,
  });
}

async function expectStartupFrames(
  expectedSurface: "empty" | "chooser",
): Promise<void> {
  const frames = await browser.executeAsync<
    { surface: string | null; workspace: boolean; focused: string | null }[],
    []
  >((done) => {
    const frames: {
      surface: string | null;
      workspace: boolean;
      focused: string | null;
    }[] = [];
    const sample = () => {
      const surface = document.querySelector<HTMLElement>(
        "[data-startup-vault-surface]",
      );
      const focused = document.activeElement as HTMLElement | null;
      frames.push({
        surface: surface?.dataset.startupVaultSurface ?? null,
        workspace: document.querySelector("[role=tree]") !== null,
        focused:
          focused?.getAttribute("data-command-id") ??
          focused?.dataset.startupVaultPath ??
          null,
      });
      if (frames.length === 12) done(frames);
      else requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  expect(frames).toHaveLength(12);
  expect(
    frames.every(
      (frame) => frame.surface === expectedSurface && frame.workspace === false,
    ),
  ).toBe(true);
}

async function expectOpenVaultFocus(): Promise<void> {
  expect(
    await browser.execute(() =>
      document.activeElement?.getAttribute("data-command-id"),
    ),
  ).toBe("vault.open");
}

async function expectChooser(paths: string[]): Promise<void> {
  await waitForStartupSurface("chooser");
  await browser.waitUntil(
    async () => (await $$("[data-startup-vault-path]")).length === paths.length,
    { timeout: 15000, timeoutMsg: "recent-vault chooser rows did not settle" },
  );
  expect(
    await browser.execute(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>("[data-startup-vault-path]"),
      ).map((row) => row.dataset.startupVaultPath),
    ),
  ).toEqual(paths);
  expect(
    await browser.execute(() =>
      document.activeElement?.getAttribute("data-startup-vault-path"),
    ),
  ).toBe(paths[0]);
}

describe("packaged startup vault recovery", () => {
  it("shows a stable actionable Open vault state without a session", async () => {
    await waitForPackagedMainWindow();
    await waitForStartupSurface("empty");
    await expectStartupFrames("empty");
    await expectOpenVaultFocus();
  });

  it("restores a native-recorded vault once on relaunch", async () => {
    await recordVault(FIRST_VAULT_PATH);
    expect(await readSession()).toMatchObject({
      last_vault: FIRST_VAULT_PATH,
      recent_vaults: [FIRST_VAULT_PATH],
    });

    await relaunch();
    await $(`[data-startup-vault-surface]`).waitForExist({ reverse: true });
    await $("[role=tree]").waitForExist({ timeout: 15000 });
    expect(await $$('[role="tree"]')).toHaveLength(1);
    expect(await readSession()).toMatchObject({
      last_vault: FIRST_VAULT_PATH,
      recent_vaults: [FIRST_VAULT_PATH],
    });
  });

  it("auto-opens the sole recent vault after last is cleared", async () => {
    const session = await invokeTauriCommand<VaultSession>(
      "vault_session_clear_last",
    );
    expect(session).toMatchObject({
      last_vault: null,
      recent_vaults: [FIRST_VAULT_PATH],
    });

    await relaunch();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
    expect(await $$('[role="tree"]')).toHaveLength(1);
  });

  it("offers newest-first recents after last is cleared and promotes selection", async () => {
    await recordVault(SECOND_VAULT_PATH);
    expect(await readSession()).toMatchObject({
      last_vault: SECOND_VAULT_PATH,
      recent_vaults: [SECOND_VAULT_PATH, FIRST_VAULT_PATH],
    });
    await invokeTauriCommand<VaultSession>("vault_session_clear_last");

    await relaunch();
    await expectChooser([SECOND_VAULT_PATH, FIRST_VAULT_PATH]);
    await expectStartupFrames("chooser");

    const rows = await $$("[data-startup-vault-path]");
    const firstVaultRow = rows[1];
    if (firstVaultRow === undefined) {
      throw new Error("the older recent-vault chooser row is unavailable");
    }
    await firstVaultRow.click();
    await $("[role=tree]").waitForExist({ timeout: 15000 });
    expect(await readSession()).toMatchObject({
      last_vault: FIRST_VAULT_PATH,
      recent_vaults: [FIRST_VAULT_PATH, SECOND_VAULT_PATH],
    });
  });

  it("keeps the reduced-motion chooser stable and focused without motion events", async () => {
    await invokeTauriCommand<VaultSession>("vault_session_clear_last");
    await relaunch();
    await browser.execute(() => {
      document.documentElement.dataset.animations = "false";
    });
    await expectChooser([FIRST_VAULT_PATH, SECOND_VAULT_PATH]);
    const events = await browser.executeAsync<string[], []>((done) => {
      const seen: string[] = [];
      const capture = (event: Event) => seen.push(event.type);
      document.addEventListener("transitionstart", capture, true);
      document.addEventListener("animationstart", capture, true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          document.removeEventListener("transitionstart", capture, true);
          document.removeEventListener("animationstart", capture, true);
          done(seen);
        }),
      );
    });
    expect(events).toEqual([]);
    await expectStartupFrames("chooser");
  });
});
