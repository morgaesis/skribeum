import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
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
let demoServer: ChildProcess | null = null;

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
process.env.SKRIBEUM_E2E_BINARY = appBinaryPath;

const capabilities: TauriCapabilities[] = [
  {
    browserName: "tauri",
    "tauri:options": { application: appBinaryPath },
  },
];

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: [path.join(configDirectory, "*.spec.ts")],
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
  framework: "mocha",
  mochaOpts: {
    ui: "bdd",
    timeout: 300000,
  },
  reporters: ["spec"],
  onPrepare: startDemoServer,
  onComplete: stopDemoServer,
};
