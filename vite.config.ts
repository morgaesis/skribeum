/// <reference types="vitest/config" />
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// Dev server settings follow Tauri's expectations: fixed port, no screen
// clearing so Rust build errors stay visible, and TAURI_ env exposure.
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // The web test suite: component-level editor tests running under jsdom.
  // End-to-end coverage lives in tests/e2e under WebdriverIO.
  test: {
    environment: "jsdom",
    include: ["tests/web/**/*.test.ts"],
    setupFiles: ["tests/web/setup.ts"],
  },
});
