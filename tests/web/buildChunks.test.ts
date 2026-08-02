import path from "node:path";
import { fileURLToPath } from "node:url";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import type { OutputAsset, OutputChunk, RollupOutput } from "rollup";
import { build } from "vite";
import { describe, expect, it } from "vitest";

describe("rendering build boundaries", () => {
  it("keeps optional renderers out of initial chunks and bundles KaTeX fonts locally", async () => {
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const result = (await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [svelte(), tailwindcss()],
      build: { write: false },
    })) as RollupOutput;
    const chunks = result.output.filter(
      (item): item is OutputChunk => item.type === "chunk",
    );
    const byFile = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
    const initial = new Set<string>();
    const visit = (fileName: string) => {
      if (initial.has(fileName)) return;
      initial.add(fileName);
      for (const dependency of byFile.get(fileName)?.imports ?? [])
        visit(dependency);
    };
    for (const entry of chunks.filter((chunk) => chunk.isEntry))
      visit(entry.fileName);
    const moduleIds = (names: Iterable<string>) =>
      [...names].flatMap((name) =>
        Object.keys(byFile.get(name)?.modules ?? {}),
      );
    const initialMermaidModules = moduleIds(initial).filter((id) =>
      /node_modules\/mermaid\//.test(id),
    );
    expect(
      initialMermaidModules.filter(
        (id) =>
          !/\/dist\/chunks\/mermaid\.core\/chunk-[A-Z0-9]+\.mjs$/.test(id),
      ),
    ).toEqual([]);
    const initialMermaidBytes = [...initial].reduce(
      (total, name) =>
        total +
        Object.entries(byFile.get(name)?.modules ?? {}).reduce(
          (chunkTotal, [id, module]) =>
            chunkTotal +
            (/node_modules\/mermaid\//.test(id) ? module.renderedLength : 0),
          0,
        ),
      0,
    );
    expect(initialMermaidBytes).toBeLessThan(8_000);
    expect(
      chunks.some((chunk) =>
        Object.keys(chunk.modules).some((id) =>
          /node_modules\/mermaid\//.test(id),
        ),
      ),
    ).toBe(true);

    const lazyLanguageModules = [
      /node_modules\/@codemirror\/lang-json\//,
      /node_modules\/@codemirror\/lang-python\//,
      /node_modules\/@codemirror\/lang-rust\//,
      /node_modules\/@codemirror\/lang-yaml\//,
      /node_modules\/@codemirror\/legacy-modes\/mode\/shell\./,
    ];
    const initialModuleIds = moduleIds(initial);
    for (const languageModule of lazyLanguageModules) {
      expect(initialModuleIds.filter((id) => languageModule.test(id))).toEqual(
        [],
      );
      expect(
        chunks.some((chunk) =>
          Object.keys(chunk.modules).some((id) => languageModule.test(id)),
        ),
      ).toBe(true);
    }

    const assets = result.output.filter(
      (item): item is OutputAsset => item.type === "asset",
    );
    expect(
      assets.some((asset) => /KaTeX_.*\.woff2$/.test(asset.fileName)),
    ).toBe(true);
    const css = assets
      .filter((asset) => asset.fileName.endsWith(".css"))
      .map((asset) => String(asset.source))
      .join("\n");
    expect(css).not.toMatch(/url\(["']?https?:/i);
  }, 30_000);
});
