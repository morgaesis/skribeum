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
  // End-to-end coverage lives in tests/e2e under WebdriverIO. The browser
  // export condition makes component mounting resolve Svelte's client
  // runtime instead of the server one under jsdom.
  test: {
    environment: "jsdom",
    // Component styles are processed so tests can assert computed style
    // rather than markup alone.
    css: true,
    include: ["tests/web/**/*.test.ts", "tests/demo.test.ts"],
    setupFiles: ["tests/web/setup.ts"],
    server: {
      deps: {
        inline: ["svelte"],
      },
    },
  },
  resolve: process.env.VITEST === "true" ? { conditions: ["browser"] } : {},
});
