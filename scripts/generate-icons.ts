import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dir, "..");
const sourcePath = join(repositoryRoot, "assets/brand/skribeum-lamp.svg");
const appMasterPath = join(repositoryRoot, "assets/brand/app-icon-1024.png");
const publicDirectory = join(repositoryRoot, "public");
const tauriIconDirectory = join(repositoryRoot, "src-tauri/icons");

const iconFiles = [
  "32x32.png",
  "128x128.png",
  "128x128@2x.png",
  "icon.png",
  "icon.icns",
  "icon.ico",
  "Square30x30Logo.png",
  "Square44x44Logo.png",
  "Square71x71Logo.png",
  "Square89x89Logo.png",
  "Square107x107Logo.png",
  "Square142x142Logo.png",
  "Square150x150Logo.png",
  "Square284x284Logo.png",
  "Square310x310Logo.png",
  "StoreLogo.png",
] as const;

const lightStyles = `
    .surface { fill: #F5F2E9; }
    .lamp-shade { fill: #1E4D3B; }
    .lamp-body { fill: #14251D; }`;

function svgDocument(
  definitions: string,
  mark: "lamp-full" | "lamp-small",
  width?: number,
): string {
  const dimensions =
    width === undefined ? "" : ` width="${width}" height="${width}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${dimensions}>
  <defs>${definitions}</defs>
  <style>${lightStyles}
  </style>
  <rect class="surface" width="64" height="64" rx="15" />
  <use href="#${mark}" width="64" height="64" />
</svg>
`;
}

function faviconDocument(definitions: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>${definitions}</defs>
  <style>${lightStyles}
    .small-mark { display: none; }
    @media (prefers-color-scheme: dark) {
      .surface { fill: #14251D; }
      .lamp-shade { fill: #7FBF9E; }
      .lamp-body { fill: #F5F2E9; }
    }
    @media (max-width: 16px), (max-height: 16px) {
      .full-mark { display: none; }
      .small-mark { display: inline; }
    }
  </style>
  <rect class="surface" width="64" height="64" rx="15" />
  <use class="full-mark" href="#lamp-full" width="64" height="64" />
  <use class="small-mark" href="#lamp-small" width="64" height="64" />
</svg>
`;
}

async function runTauriIcon(
  input: string,
  output: string,
  pngSizes: number[] = [],
): Promise<void> {
  const argumentsList = ["bun", "tauri", "icon", "--output", output];
  for (const size of pngSizes) {
    argumentsList.push("--png", String(size));
  }
  argumentsList.push(input);
  const process = Bun.spawn(argumentsList, {
    cwd: repositoryRoot,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error(`Tauri icon generation failed with exit code ${exitCode}`);
  }
}

function icoEntries(icon: Uint8Array): Array<{
  width: number;
  height: number;
  offset: number;
  size: number;
  entryOffset: number;
}> {
  const view = new DataView(icon.buffer, icon.byteOffset, icon.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) {
    throw new Error("Generated icon.ico has an invalid header");
  }
  const count = view.getUint16(4, true);
  return Array.from({ length: count }, (_, index) => {
    const entryOffset = 6 + index * 16;
    const rawWidth = icon[entryOffset];
    const rawHeight = icon[entryOffset + 1];
    if (rawWidth === undefined || rawHeight === undefined) {
      throw new Error("Generated icon.ico has a truncated directory");
    }
    return {
      width: rawWidth === 0 ? 256 : rawWidth,
      height: rawHeight === 0 ? 256 : rawHeight,
      size: view.getUint32(entryOffset + 8, true),
      offset: view.getUint32(entryOffset + 12, true),
      entryOffset,
    };
  });
}

function replaceIco16(icon: Uint8Array, simplifiedPng: Uint8Array): Uint8Array {
  const entries = icoEntries(icon);
  const target = entries.find(
    (entry) => entry.width === 16 && entry.height === 16,
  );
  if (target === undefined) {
    throw new Error("Generated icon.ico does not contain a 16px entry");
  }
  const headerLength = 6 + entries.length * 16;
  const imageData = entries.map((entry) =>
    entry === target
      ? simplifiedPng
      : icon.slice(entry.offset, entry.offset + entry.size),
  );
  const totalLength =
    headerLength +
    imageData.reduce((total, bytes) => total + bytes.byteLength, 0);
  const result = new Uint8Array(totalLength);
  result.set(icon.slice(0, headerLength));
  const view = new DataView(result.buffer);
  let nextOffset = headerLength;
  for (const [index, entry] of entries.entries()) {
    const bytes = imageData[index];
    if (bytes === undefined) {
      throw new Error("Generated icon.ico has a missing image payload");
    }
    view.setUint32(entry.entryOffset + 8, bytes.byteLength, true);
    view.setUint32(entry.entryOffset + 12, nextOffset, true);
    result.set(bytes, nextOffset);
    nextOffset += bytes.byteLength;
  }
  return result;
}

function bytesEqual(first: Uint8Array, second: Uint8Array): boolean {
  return (
    first.byteLength === second.byteLength &&
    first.every((byte, index) => byte === second[index])
  );
}

async function findGeneratedPng(
  directory: string,
  size: number,
): Promise<string> {
  const expectedName = `${size}x${size}.png`;
  const names = await readdir(directory);
  if (!names.includes(expectedName)) {
    throw new Error(
      `Tauri did not generate ${expectedName} in ${basename(directory)}`,
    );
  }
  return join(directory, expectedName);
}

async function copyFile(source: string, destination: string): Promise<void> {
  await writeFile(destination, await readFile(source));
}

async function main(): Promise<void> {
  const source = await readFile(sourcePath, "utf8");
  const definitions = source.match(/<defs>([\s\S]*?)<\/defs>/)?.[1];
  if (definitions === undefined) {
    throw new Error("The canonical lamp SVG does not contain definitions");
  }

  const temporaryRoot = await mkdtemp(join(tmpdir(), "skribeum-icons-"));
  try {
    const appSvg = join(temporaryRoot, "app-icon.svg");
    const smallSvg = join(temporaryRoot, "small-icon.svg");
    const generatedIcons = join(temporaryRoot, "platform-icons");
    const fullRasters = join(temporaryRoot, "full-rasters");
    const smallRasters = join(temporaryRoot, "small-rasters");
    await mkdir(generatedIcons);
    await mkdir(fullRasters);
    await mkdir(smallRasters);
    await writeFile(appSvg, svgDocument(definitions, "lamp-full", 1024));
    await writeFile(smallSvg, svgDocument(definitions, "lamp-small", 16));

    await runTauriIcon(appSvg, generatedIcons);
    await runTauriIcon(appSvg, fullRasters, [32, 180, 512, 1024]);
    await runTauriIcon(smallSvg, smallRasters, [16]);

    await mkdir(tauriIconDirectory, { recursive: true });
    for (const name of iconFiles) {
      await copyFile(
        join(generatedIcons, name),
        join(tauriIconDirectory, name),
      );
    }

    const simplified16Path = await findGeneratedPng(smallRasters, 16);
    const icoPath = join(tauriIconDirectory, "icon.ico");
    const simplified16 = await readFile(simplified16Path);
    const patchedIco = replaceIco16(await readFile(icoPath), simplified16);
    const patched16Entry = icoEntries(patchedIco).find(
      (entry) => entry.width === 16 && entry.height === 16,
    );
    if (
      patched16Entry === undefined ||
      !bytesEqual(
        patchedIco.slice(
          patched16Entry.offset,
          patched16Entry.offset + patched16Entry.size,
        ),
        simplified16,
      )
    ) {
      throw new Error(
        "The icon.ico 16px entry does not match the simplified mark",
      );
    }
    await writeFile(icoPath, patchedIco);

    await copyFile(await findGeneratedPng(fullRasters, 1024), appMasterPath);
    await copyFile(
      await findGeneratedPng(fullRasters, 180),
      join(publicDirectory, "apple-touch-icon.png"),
    );
    await writeFile(
      join(publicDirectory, "favicon.svg"),
      faviconDocument(definitions),
    );

    const inspectionArgument = process.argv.find((argument) =>
      argument.startsWith("--inspection-dir="),
    );
    if (inspectionArgument !== undefined) {
      const inspectionDirectory = resolve(
        repositoryRoot,
        inspectionArgument.slice("--inspection-dir=".length),
      );
      await mkdir(inspectionDirectory, { recursive: true });
      await copyFile(
        simplified16Path,
        join(inspectionDirectory, "favicon-16.png"),
      );
      await copyFile(
        await findGeneratedPng(fullRasters, 32),
        join(inspectionDirectory, "favicon-32.png"),
      );
      await copyFile(
        await findGeneratedPng(fullRasters, 180),
        join(inspectionDirectory, "favicon-180.png"),
      );
      await copyFile(
        await findGeneratedPng(fullRasters, 512),
        join(inspectionDirectory, "app-icon-512.png"),
      );
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
