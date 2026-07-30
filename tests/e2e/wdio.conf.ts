import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TauriCapabilities } from "@wdio/tauri-service";

const configDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(configDirectory, "../..");

// The workspace places build output in target/ at the repository root. The
// e2e suite runs against the debug binary built with the webdriver feature:
//   bun tauri build --debug --no-bundle --features webdriver
const binaryExtension = process.platform === "win32" ? ".exe" : "";
const appBinaryPath = path.join(
  repositoryRoot,
  "target",
  "debug",
  `skribeum-app${binaryExtension}`,
);

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
    timeout: 120000,
  },
  reporters: ["spec"],
};
