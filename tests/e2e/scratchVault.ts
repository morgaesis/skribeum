// The scratch vault the end-to-end suite edits. The WebdriverIO config
// recreates it before the app launches and exports its location through
// SKRIBEUM_E2E_VAULT; the webdriver-feature build announces that path to
// the webview, which opens the vault on startup (the directory-picker
// dialog cannot be driven headlessly). Specs assert against the files on
// disk directly.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkoutKey = createHash("sha256")
  .update(fileURLToPath(import.meta.url))
  .digest("hex")
  .slice(0, 12);
export const SCRATCH_VAULT_PATH = path.join(
  os.tmpdir(),
  `skribeum-e2e-vault-${checkoutKey}`,
);
export const SCRATCH_SETTINGS_PATH = path.join(
  os.tmpdir(),
  `skribeum-e2e-settings-${checkoutKey}.json`,
);

export const LF_NOTE_NAME = "note.md";
export const LF_NOTE_CONTENT = "alpha\nbeta\ngamma\n";

export const CRLF_NOTE_NAME = "crlf.md";
export const CRLF_NOTE_CONTENT = "first\r\nsecond\r\nthird\r\n";

// Named to sort after the other notes so the keyboard-traversal spec's
// arrow-key expectations over the first two rows stay stable.
export const LIVE_PREVIEW_NOTE_NAME = "z-live-preview.md";
export const LIVE_PREVIEW_NOTE_CONTENT =
  "# Sunrise heading\n\nbody text here\n\n- [ ] Review task\n";

export const MOTION_PREVIEW_NOTE_NAME = "zy-motion-preview.md";
export const MOTION_PREVIEW_NOTE_CONTENT =
  "# Motion heading\n\n[short link](https://example.com/path)\n\n![[missing-note]]\n\n> [!note]+ Deliberate callout\n> callout body\n\nafter motion constructs\n";

export const RENDERING_NOTE_NAME = "zz-rendering.md";
export const RENDERING_NOTE_CONTENT =
  "# Rendered content\n\nInline $a^2 + b^2 = c^2$.\n\n$$\nE = mc^2\n$$\n\n```mermaid\ngraph TD\n  A --> B\n```\n\n```mermaid\nthis is not valid mermaid\n```\n";

export const TAG_REFRESH_NOTE_NAME = "zz-tag-refresh.md";
export const TAG_REFRESH_NOTE_CONTENT = "Tag catalog refresh fixture.\n";

export const TAG_DELETE_NOTE_NAME = "zz-tag-delete.md";
export const TAG_DELETE_NOTE_CONTENT = "Unopened note with #delete-only.\n";

export const TAG_DELETE_PROBE_NOTE_NAME = "zz-tag-delete-probe.md";
export const TAG_DELETE_PROBE_NOTE_CONTENT = "Tag deletion probe.\n";

export const TAG_COMPLETION_CATALOG_NOTE_NAME = "zz-tag-completion-catalog.md";
export const TAG_COMPLETION_CATALOG_NOTE_CONTENT =
  "#project/cedar-room #project/cedar-room #context/outdoors\n";

export const TAG_COMPLETION_TARGET_NOTE_NAME = "zz-tag-completion-target.md";
export const TAG_COMPLETION_TARGET_NOTE_CONTENT = "Tag completion target.";

export const VISUAL_NOTE_NAME = "zzz-reading-room.md";
export const VISUAL_NOTE_CONTENT = [
  "---",
  "title: A room for reading",
  "status: draft",
  "topics: [typography, editing, focus]",
  "published: false",
  "---",
  "",
  "# A room for reading",
  "",
  "Patient typography gives a long note room to breathe while keeping its structure easy to scan.",
  "",
  "## Deliberate hierarchy",
  "",
  "- Aligned blocks keep the reading rhythm steady.",
  "",
  "> [!tip] Reading note",
  "> Callout text follows the same comfortable column width as the surrounding prose, even when the sentence is long enough to wrap onto several visual lines inside its padded frame.",
  "",
  "### Practical details",
  "",
  "Use `inline code` for exact names and fenced blocks for examples:",
  "",
  "```ts",
  'const measure = "comfortable";',
  "```",
  "",
  "| Surface | Purpose |",
  "| --- | --- |",
  "| Prose | Sustained reading |",
  "| Code | Exact notation |",
  "",
].join("\n");

export const TABLE_GEOMETRY_NOTE_CONTENT = [
  "# Table geometry",
  "",
  "| Option | Seats | Daylight | Quiet zone | Notes |",
  "| --- | ---: | :---: | :---: | --- |",
  "| Cedar Room | 18 | Yes | Yes | Best fit for focused sessions |",
  "| Workshop Bay | 30 | Limited | No | Good access for large equipment |",
  "| Courtyard | 24 | Yes | Partial | Needs a rain plan |",
  "",
  "A second table keeps its own source-derived proportions.",
  "",
  "| Trial | Change | Result | Next step |",
  "| --- | --- | --- | --- |",
  "| A | Shorter welcome script | People began sooner | Keep |",
  "| B | Signs at seated eye level | Routes were easier to find | Test larger type |",
  "| C | Shared tool table | Created a queue | Split into two stations |",
  "",
].join("\n");

export const REVEAL_NOTE_NAME = "zzzz-reveal.md";
export const REVEAL_NOTE_CONTENT =
  "# Reveal interactions\n\n> [!tip] Linked callout\n> First body line.\n> Read [inside link](inside-target).\n\n[Outside link](outside-target)\n\ncursor parking\n";

export const NAVIGATION_SOURCE_NOTE_NAME = "zzz-navigation-source.md";
export const NAVIGATION_SOURCE_NOTE_CONTENT =
  "# Navigation source\n\nFollow [[zzz-navigation-target]].\n\n#shared\n";
export const NAVIGATION_TARGET_NOTE_NAME = "zzz-navigation-target.md";
export const NAVIGATION_TARGET_NOTE_CONTENT =
  "# Navigation target\n\nWikilink destination content.\n\n#shared\n";

export const CANVAS_FILE_NAME = "zzz-board.canvas";
export const CANVAS_REFERENCE_NAME = "z-live-preview.md";
export const CANVAS_FILE_CONTENT = JSON.stringify({
  nodes: [
    {
      id: "idea",
      type: "text",
      text: "Stored idea",
      x: 40,
      y: 50,
      width: 180,
      height: 100,
    },
    {
      id: "note",
      type: "file",
      file: CANVAS_REFERENCE_NAME,
      x: 360,
      y: 180,
      width: 260,
      height: 160,
    },
  ],
  edges: [
    {
      id: "connection",
      fromNode: "idea",
      fromSide: "right",
      toNode: "note",
      toSide: "left",
    },
  ],
});

/**
 * Resets the scratch vault to its fixture files. The vault root itself is
 * never deleted: the WebdriverIO launcher starts the app before the worker
 * process re-evaluates this module, and removing a directory an inotify
 * watcher is subscribed to silently kills the subscription for the rest of
 * the session. Contents are reset entry by entry instead.
 */
export function createScratchVault(): void {
  rmSync(SCRATCH_SETTINGS_PATH, { force: true });
  mkdirSync(SCRATCH_VAULT_PATH, { recursive: true });
  for (const entry of readdirSync(SCRATCH_VAULT_PATH)) {
    rmSync(path.join(SCRATCH_VAULT_PATH, entry), {
      recursive: true,
      force: true,
    });
  }
  writeFileSync(path.join(SCRATCH_VAULT_PATH, LF_NOTE_NAME), LF_NOTE_CONTENT);
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, CRLF_NOTE_NAME),
    CRLF_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, LIVE_PREVIEW_NOTE_NAME),
    LIVE_PREVIEW_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, MOTION_PREVIEW_NOTE_NAME),
    MOTION_PREVIEW_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, RENDERING_NOTE_NAME),
    RENDERING_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_REFRESH_NOTE_NAME),
    TAG_REFRESH_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_DELETE_NOTE_NAME),
    TAG_DELETE_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_DELETE_PROBE_NOTE_NAME),
    TAG_DELETE_PROBE_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_COMPLETION_CATALOG_NOTE_NAME),
    TAG_COMPLETION_CATALOG_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, TAG_COMPLETION_TARGET_NOTE_NAME),
    TAG_COMPLETION_TARGET_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, VISUAL_NOTE_NAME),
    VISUAL_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, NAVIGATION_SOURCE_NOTE_NAME),
    NAVIGATION_SOURCE_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, NAVIGATION_TARGET_NOTE_NAME),
    NAVIGATION_TARGET_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, CANVAS_FILE_NAME),
    CANVAS_FILE_CONTENT,
  );
}
