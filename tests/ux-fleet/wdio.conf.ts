// biome-ignore-all format: Keep the exploratory harness within its line budget.
import path from "node:path";
import { config as e2eConfig } from "../e2e/wdio.conf";
import { createFleetVault, FLEET_VAULT_PATH } from "./vault";

createFleetVault();
process.env.SKRIBEUM_E2E_VAULT = FLEET_VAULT_PATH;

export const config: WebdriverIO.Config = {
  ...e2eConfig,
  specs: [path.join(import.meta.dirname, "personas.spec.ts")],
  logLevel: "warn",
  waitforTimeout: 30_000,
  connectionRetryTimeout: 180_000,
  mochaOpts: {
    ui: "bdd",
    timeout: 900_000,
  },
};
