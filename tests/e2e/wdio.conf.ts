import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TauriCapabilities } from "@wdio/tauri-service";
import {
  createScratchVault,
  SCRATCH_EDIT_HISTORY_PATH,
  SCRATCH_SETTINGS_PATH,
  SCRATCH_VAULT_PATH,
  SCRATCH_VAULT_SESSION_PATH,
} from "./scratchVault";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "../..");
let demoServer: ChildProcess | null = null;

const startupVaultMode = process.env.SKRIBEUM_E2E_STARTUP_VAULT_MODE === "1";
const startupVaultRunId =
  process.env.SKRIBEUM_E2E_STARTUP_VAULT_RUN_ID ?? randomUUID();
const startupVaultFixtureRoot = path.join(
  os.tmpdir(),
  `skribeum-e2e-startup-vault-${startupVaultRunId}`,
);
const startupVaultFirstPath = path.join(startupVaultFixtureRoot, "first");
const startupVaultSecondPath = path.join(startupVaultFixtureRoot, "second");
const startupVaultSettingsPath = path.join(
  startupVaultFixtureRoot,
  "settings.json",
);
const startupVaultSessionPath = path.join(
  startupVaultFixtureRoot,
  "vault-session.json",
);
const startupVaultEditHistoryPath = path.join(
  startupVaultFixtureRoot,
  "edit-history.jsonl",
);

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("browser demo test server did not receive a TCP port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

const inheritedEmbeddedPort = process.env.TAURI_WEBDRIVER_PORT;
const embeddedPort =
  inheritedEmbeddedPort === undefined
    ? await availablePort()
    : Number.parseInt(inheritedEmbeddedPort, 10);
process.env.TAURI_WEBDRIVER_PORT = String(embeddedPort);

async function startDemoServer(): Promise<void> {
  await buildStaticDemo();
  const port = await availablePort();
  const url = `http://127.0.0.1:${port}/`;
  demoServer = spawn(
    "bun",
    [
      "x",
      "vite",
      "preview",
      "--config",
      "demo/vite.config.ts",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
    { cwd: repositoryRoot, stdio: "ignore" },
  );
  process.env.SKRIBEUM_E2E_DEMO_URL = url;
  await browserDemoReady(url);
}

async function buildStaticDemo(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const build = spawn("bun", ["run", "demo:build"], {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
    const timeout = setTimeout(() => {
      build.kill();
      reject(new Error("static browser demo build timed out"));
    }, 60_000);
    build.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    build.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else
        reject(new Error(`static browser demo build exited with code ${code}`));
    });
  });
}

async function browserDemoReady(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (demoServer?.exitCode !== null) {
      throw new Error(
        `browser demo test server exited with code ${demoServer?.exitCode}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The server has not bound its port yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser demo test server did not become ready");
}

async function stopDemoServer(): Promise<void> {
  const server = demoServer;
  demoServer = null;
  if (server === null || server.exitCode !== null) return;
  server.kill();
  await Promise.race([
    new Promise<void>((resolve) => server.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

async function prepareSuite(): Promise<void> {
  if (startupVaultMode) {
    // This mode deliberately retains every generated path. It needs a fresh
    // session without sharing normal E2E or user data, and it tests relaunches
    // against the same retained session document.
    mkdirSync(startupVaultFirstPath, { recursive: true });
    mkdirSync(startupVaultSecondPath, { recursive: true });
    return;
  }
  // The configuration module is evaluated again for workers and reloaded
  // sessions. The launcher calls onPrepare once, so reset here to preserve
  // the note and app-data state across a deliberate binary relaunch.
  createScratchVault();
  await startDemoServer();
}
if (startupVaultMode) {
  process.env.SKRIBEUM_E2E_STARTUP_VAULT_RUN_ID = startupVaultRunId;
  process.env.SKRIBEUM_E2E_STARTUP_VAULT_FIRST = startupVaultFirstPath;
  process.env.SKRIBEUM_E2E_STARTUP_VAULT_SECOND = startupVaultSecondPath;
  // Suppress the ordinary frontend vault injection. The session is the only
  // startup source in this mode.
  delete process.env.SKRIBEUM_E2E_VAULT;
  delete process.env.SKRIBEUM_E2E_RESET_WORKSPACE;
  process.env.SKRIBEUM_E2E_SETTINGS = startupVaultSettingsPath;
  process.env.SKRIBEUM_E2E_VAULT_SESSION = startupVaultSessionPath;
  process.env.SKRIBEUM_E2E_EDIT_HISTORY = startupVaultEditHistoryPath;
} else {
  process.env.SKRIBEUM_E2E_VAULT = SCRATCH_VAULT_PATH;
  process.env.SKRIBEUM_E2E_SETTINGS = SCRATCH_SETTINGS_PATH;
  process.env.SKRIBEUM_E2E_VAULT_SESSION = SCRATCH_VAULT_SESSION_PATH;
  process.env.SKRIBEUM_E2E_RESET_WORKSPACE = "1";
  process.env.SKRIBEUM_E2E_EDIT_HISTORY = SCRATCH_EDIT_HISTORY_PATH;
}

// The workspace places build output in target/ at the repository root. The
// e2e suite runs against the debug binary built with the webdriver feature
// and the webdriver config overlay (which enables withGlobalTauri so the
// embedded driver service can reach the Tauri API; release builds keep it
// off):
//   bun tauri build --debug --no-bundle --features webdriver --config src-tauri/tauri.webdriver.conf.json
const binaryExtension = process.platform === "win32" ? ".exe" : "";
const configuredBinary = process.env.SKRIBEUM_E2E_BINARY;
const appBinaryPath =
  configuredBinary === undefined
    ? path.join(
        repositoryRoot,
        "target",
        "debug",
        `skribeum-app${binaryExtension}`,
      )
    : path.resolve(configuredBinary);
process.env.SKRIBEUM_E2E_BINARY = appBinaryPath;

const capabilities: TauriCapabilities[] = [
  {
    browserName: "tauri",
    "tauri:options": { application: appBinaryPath },
  },
];

/**
 * Waits for the application to be reachable before any spec in a session
 * runs.
 *
 * The WebDriver service injects a wrapper that polls for the Tauri core for a
 * fixed five seconds and then throws `Tauri core.invoke not available after 5s
 * timeout`; nothing it accepts as configuration changes that bound. On a
 * loaded runner the window exists before the bridge does, so whichever spec
 * asks for the first surface fails, and because that spec's later assertions
 * then read an empty document, the failure surfaces as an unrelated
 * expectation rather than as a startup problem. It has landed on every
 * platform in this matrix, on a different test each time.
 *
 * Absorbing the race once per session costs seconds on a slow machine and
 * nothing on a fast one. The shell is found by plain element lookup, which
 * needs no injected script, and the core is then exercised by the smallest
 * possible script until it answers, so a genuine startup failure still fails
 * here, loudly and by its own name.
 */
async function waitForApplicationReady(): Promise<void> {
  await $(".skr-shell").waitForExist({
    timeout: 60_000,
    timeoutMsg: "the application shell never mounted",
  });
  await browser.waitUntil(
    async () => {
      try {
        return (await browser.execute(() => true)) === true;
      } catch {
        // The injected wrapper throws while the core is still absent.
        return false;
      }
    },
    {
      timeout: 60_000,
      interval: 500,
      timeoutMsg: "the Tauri core never became reachable from the driver",
    },
  );
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: startupVaultMode
    ? [path.join(configDirectory, "startup-vault.spec.ts")]
    : [
        // The first four run before any browser-demo navigation, in any order
        // relative to each other: each needs the shared app window on its
        // freshly launched desktop content, and none navigates it away.
        // smoke.spec.ts ends with browser-demo tests that navigate the same
        // window away and never navigate it back, and
        // unified-command-surface.spec.ts navigates to the browser demo before
        // every test, so running after either would leave no desktop-mode
        // window for these files to find.
        path.join(configDirectory, "properties-statusline.spec.ts"),
        path.join(configDirectory, "windowChrome.spec.ts"),
        path.join(configDirectory, "workspace.spec.ts"),
        path.join(configDirectory, "motion.spec.ts"),
        path.join(configDirectory, "smoke.spec.ts"),
        path.join(configDirectory, "unified-command-surface.spec.ts"),
        path.join(configDirectory, "palette.spec.ts"),
        path.join(configDirectory, "control-language.spec.ts"),
      ],
  maxInstances: 1,
  // The embedded driver provider is the @wdio/tauri-service default: the app
  // itself serves WebDriver via tauri-plugin-wdio-webdriver, so no external
  // tauri-driver process is needed on any platform.
  services: [["@wdio/tauri-service", { appBinaryPath, embeddedPort }]],
  capabilities,
  logLevel: "warn",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,
  // No spec-file retry. Re-running a spec file in this harness does not
  // work: the suite prepares its vault and application session once, and a
  // retried file runs against a session already torn down. Measured on the
  // Windows leg of the run that introduced it, a first pass of 89 passing
  // and 1 failing became a retry of 20 passing and 70 failing, so the retry
  // converted an occasional one-test flake into a reliably red job. A flake
  // that fails one assertion is easier to read than one that fails seventy.
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 300000,
  },
  reporters: ["spec"],
  before: waitForApplicationReady,
  onPrepare: prepareSuite,
  onComplete: stopDemoServer,
};
