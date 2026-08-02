import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, normalizePath, type Plugin } from "vite";

const demoRoot = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = resolve(demoRoot, "..");
const sourceRoot = resolve(repositoryRoot, "src");

function demoIpcBoundary(): Plugin {
  const redirects = new Map([
    [
      normalizePath(resolve(sourceRoot, "lib/ipc/bindings")),
      normalizePath(resolve(demoRoot, "lib/ipc/bindings.ts")),
    ],
    [
      normalizePath(resolve(sourceRoot, "lib/ipc/services")),
      normalizePath(resolve(demoRoot, "lib/ipc/services.ts")),
    ],
    [
      normalizePath(resolve(sourceRoot, "lib/ipc/vault")),
      normalizePath(resolve(demoRoot, "lib/ipc/vault.ts")),
    ],
  ]);
  const dialogStub = normalizePath(resolve(demoRoot, "lib/ipc/dialog.ts"));

  return {
    name: "skribeum-demo-ipc-boundary",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "@tauri-apps/plugin-dialog") {
        return dialogStub;
      }
      if (importer === undefined || !source.startsWith(".")) {
        return null;
      }
      const importerPath = importer.split("?", 1)[0];
      if (importerPath === undefined) {
        return null;
      }
      const candidate = normalizePath(
        resolve(dirname(importerPath), source),
      ).replace(/\.ts$/, "");
      return redirects.get(candidate) ?? null;
    },
  };
}

export default defineConfig({
  root: demoRoot,
  base: "/",
  publicDir: resolve(repositoryRoot, "public"),
  plugins: [
    demoIpcBoundary(),
    svelte({ configFile: resolve(repositoryRoot, "svelte.config.js") }),
    tailwindcss(),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
