import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TauriCapabilities } from "@wdio/tauri-service";
import {
  createScratchVault,
  SCRATCH_SETTINGS_PATH,
  SCRATCH_VAULT_PATH,
} from "./scratchVault";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "../..");

// Both the launcher and the worker evaluate this module before any app
// session starts, so the scratch vault exists and the seam variable is in
// the environment the app binary inherits.
createScratchVault();
process.env.SKRIBEUM_E2E_VAULT = SCRATCH_VAULT_PATH;
process.env.SKRIBEUM_E2E_SETTINGS = SCRATCH_SETTINGS_PATH;

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

const capabilities: TauriCapabilities[] = [
  {
    browserName: "tauri",
    "tauri:options": { application: appBinaryPath },
  },
];

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: [path.join(configDirectory, "smoke.spec.ts")],
  maxInstances: 1,
  // The embedded driver provider is the @wdio/tauri-service default: the app
  // itself serves WebDriver via tauri-plugin-wdio-webdriver, so no external
  // tauri-driver process is needed on any platform.
  services: [["@wdio/tauri-service", { appBinaryPath }]],
  capabilities,
  logLevel: "info",
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 2,
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 300000,
  },
  reporters: ["spec"],
};
