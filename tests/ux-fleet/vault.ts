// biome-ignore-all format: Keep the exploratory harness within its line budget.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const FLEET_SEED = 0x51ca_1e5e;
export const FLEET_NOTE_COUNT = 2_000;
export const FLEET_VAULT_PATH = path.join(os.tmpdir(), "skribeum-ux-fleet-v2");

export const NOTES = {
  start: "quickstart.md",
  daily: "Daily/2026-07-31.md",
  linkedDaily: "Daily/2026-07-30.md",
  research: "Research/Long Paper.md",
  keyboard: "Keyboard/Command Surface.md",
  zoom: "Accessibility/Zoom Review.md",
  interruption: "Interruptions/Draft.md",
  interruptionTarget: "Interruptions/Reference.md",
  deep: "Archive/Imported/Department-07/Area-04/Project-03/Topic-02/Migration Deep Note 0199.md",
  callouts: "Features/all-callout-types.md",
  rendering: "Features/rendering-surface.md",
  canvas: "demo.canvas",
} as const;

const STAMP = `.fleet-${FLEET_SEED.toString(16)}-${FLEET_NOTE_COUNT}`;
const demoVault = path.resolve(import.meta.dirname, "../../demo/lib/vault");

function writeNote(relativePath: string, content: string): void {
  const destination = path.join(FLEET_VAULT_PATH, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, content);
}

function demoFiles(directory = demoVault): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return demoFiles(absolute);
    if (entry.name.endsWith(".ts")) return [];
    return [[path.relative(demoVault, absolute), readFileSync(absolute, "utf8")]];
  });
}

function generatedPath(index: number): string {
  const department = String(index % 12).padStart(2, "0");
  const area = String(Math.floor(index / 12) % 8).padStart(2, "0");
  const project = String(Math.floor(index / 96) % 6).padStart(2, "0");
  const topic = String(Math.floor(index / 576) % 4).padStart(2, "0");
  return `Archive/Imported/Department-${department}/Area-${area}/Project-${project}/Topic-${topic}/Deep Note ${String(index).padStart(4, "0")}.md`;
}

function generatedContent(index: number): string {
  const next = String((index + 1) % FLEET_NOTE_COUNT).padStart(4, "0");
  return `---\ncategory: imported\nsequence: ${index}\ntags: [migration, corpus-${index % 17}]\n---\n# Imported note ${index}\n\nDeterministic migration material for topic ${index % 31}. The fleet-search-token-${index % 13} term supports ranked search.\n\n## Connections\n\n- [[Deep Note ${next}]]\n- #migration/corpus-${index % 17}\n\n> [!note] Preserved source\n> Nested material remains editable after import.\n`;
}

function specialNotes(): Array<[string, string]> {
  const tableRows = Array.from({ length: 220 }, (_, index) => `| Evidence ${index} | ${index * 17} | [[Deep Note ${String(index).padStart(4, "0")}]] |`).join("\n");
  const paragraphs = Array.from({ length: 300 }, (_, index) => `## Section ${index}\n\nResearch paragraph ${index} discusses deterministic evidence, citations, and longitudinal observations.`).join("\n\n");
  const calloutTypes = ["note", "abstract", "info", "todo", "tip", "success", "question", "warning", "failure", "danger", "bug", "example", "quote"];
  return [
    ...demoFiles(),
    [
      NOTES.rendering,
      `# Rendered heading one
## Rendered heading two
### Rendered heading three
#### Rendered heading four
##### Rendered heading five
###### Rendered heading six

Cursor parking area.

*Italic phrase*, **strong phrase**, and ~~struck phrase~~.
`,
    ],
    [NOTES.callouts, `# All callout types\n\n${calloutTypes.map((type) => `> [!${type}] ${type[0]?.toUpperCase()}${type.slice(1)} title\n> Rendered ${type} body.`).join("\n\n")}\n`],
    [NOTES.daily, "# 2026-07-31\n\n## Morning\n\n- Review [[Daily/2026-07-30]]\n- Capture rapid links\n"],
    [NOTES.linkedDaily, "# 2026-07-30\n\nA linked journal entry.\n"],
    [NOTES.research, `# Long paper\n\n${paragraphs}\n\n## Evidence table\n\n| Item | Score | Source |\n| --- | ---: | --- |\n${tableRows}\n`],
    [NOTES.keyboard, "# Command surface\n\n## Navigation\n\nKeyboard-only work begins here.\n\n### Search target\n\nkeyboard-navigation-evidence\n"],
    [NOTES.zoom, "# Zoom review\n\nDense prose checks wrapping, contrast, clipping, and focus visibility at enlarged scale.\n\n- [ ] Inspect the sidebar\n- [ ] Open the command palette\n"],
    [NOTES.interruption, "# Interrupted draft\n\nA sentence that remains unfinished"],
    [NOTES.interruptionTarget, "# Reference during interruption\n\nThe alternate note is safe to open mid-edit.\n"],
    [NOTES.deep, "# Deep migration note\n\nA note nested six levels below the vault root.\n\nfleet-search-token-deep\n"],
  ];
}

export function createFleetVault(force = false): void {
  const stampPath = path.join(FLEET_VAULT_PATH, STAMP);
  if (!force && existsSync(stampPath)) return;
  mkdirSync(FLEET_VAULT_PATH, { recursive: true });
  for (const entry of readdirSync(FLEET_VAULT_PATH)) {
    rmSync(path.join(FLEET_VAULT_PATH, entry), {
      recursive: true,
      force: true,
    });
  }
  const special = specialNotes();
  for (const [relativePath, content] of special) writeNote(relativePath, content);
  const reserved = new Set(special.map(([relativePath]) => relativePath));
  let generated = 0;
  for (let index = 0; generated + special.length < FLEET_NOTE_COUNT; index += 1) {
    const relativePath = generatedPath(index);
    if (reserved.has(relativePath)) continue;
    writeNote(relativePath, generatedContent(index));
    generated += 1;
  }
  writeFileSync(stampPath, `${FLEET_SEED}\n${FLEET_NOTE_COUNT}\n`);
}

export function fleetVaultIsValid(): boolean {
  const stampPath = path.join(FLEET_VAULT_PATH, STAMP);
  return existsSync(stampPath) && readFileSync(stampPath, "utf8") === `${FLEET_SEED}\n${FLEET_NOTE_COUNT}\n`;
}
