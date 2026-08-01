// biome-ignore-all format: Keep the exploratory harness within its line budget.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, utimesSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { createFleetVault, fleetVaultIsValid } from "./vault";

const root = path.resolve(import.meta.dirname, "../..");
const traces = path.join(import.meta.dirname, "traces");

function requireCommand(name: string): void {
  if (spawnSync("which", [name], { stdio: "ignore" }).status !== 0) throw new Error(`${name} is required to run the UX fleet`);
}

function run(command: string[], environment = process.env): Promise<number> {
  const executable = command[0];
  if (executable === undefined) throw new Error("empty command");
  return new Promise((resolve, reject) => {
    const child = spawn(executable, command.slice(1), {
      cwd: root,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}

function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a WebDriver port"));
        return;
      }
      server.close((error) => (error === undefined ? resolve(address.port) : reject(error)));
    });
  });
}

requireCommand("xvfb-run");
requireCommand("openbox");
rmSync(traces, { recursive: true, force: true });
mkdirSync(traces, { recursive: true });
createFleetVault(true);
if (!fleetVaultIsValid()) throw new Error("fleet vault generation failed");

if (!process.argv.includes("--skip-build")) {
  const now = new Date();
  for (const file of ["src-tauri/build.rs", "src-tauri/src/lib.rs"]) utimesSync(path.join(root, file), now, now);
  const build = await run(["bun", "tauri", "build", "--debug", "--no-bundle", "--features", "webdriver", "--config", "src-tauri/tauri.webdriver.conf.json"]);
  if (build !== 0) process.exit(build);
}

const data = path.join(traces, ".runtime");
const driverPort = await findOpenPort();
const environment = {
  ...process.env,
  TAURI_WEBDRIVER_PORT: String(driverPort),
  XDG_CONFIG_HOME: path.join(data, "config"),
  XDG_DATA_HOME: path.join(data, "data"),
  ...(process.argv.includes("--bless") ? { UX_FLEET_BLESS: "1" } : {}),
};
const fleet = await run(["xvfb-run", "-a", "sh", "-c", "openbox >/dev/null 2>&1 & manager=$!; trap 'kill \"$manager\" 2>/dev/null || true' EXIT; bunx wdio run tests/ux-fleet/wdio.conf.ts"], environment);
const aggregate = await run(["bun", "tests/ux-fleet/aggregate.ts", "--write-findings"]);
process.exit(fleet === 0 ? aggregate : fleet);
