// Wikilink resolution UX (decision 27): `.obsidian/app.json` knobs are
// honored and never overridden, targets resolve against the vault tree
// with Obsidian's shortest-path rules, and unresolved links carry a
// distinct attribute the theme styles differently.

import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import {
  computeDecorations,
  serializeDecorationSet,
} from "../../src/lib/editor/decorations/engine";
import { DECORATION_TABLE } from "../../src/lib/editor/decorations/table";
import {
  DEFAULT_OBSIDIAN_APP_CONFIG,
  parseObsidianAppConfig,
  resolveWikilinkTarget,
  type WikilinkResolutionContext,
} from "../../src/lib/editor/decorations/wikilinks";
import { skribeumMarkdownParser } from "../../src/lib/editor/markdown/obsidian";

const context: WikilinkResolutionContext = {
  paths: [
    "garden-journal.md",
    "projects/greenhouse/frame.md",
    "projects/garden-journal.md",
    "notes/Weekly Review Notes.md",
    "sketch-of-frame.png",
    "café-notat.md",
  ],
  config: DEFAULT_OBSIDIAN_APP_CONFIG,
};

describe("app.json parsing", () => {
  it("returns defaults for missing or malformed content", () => {
    expect(parseObsidianAppConfig("not json")).toEqual(
      DEFAULT_OBSIDIAN_APP_CONFIG,
    );
    expect(parseObsidianAppConfig("[]")).toEqual(DEFAULT_OBSIDIAN_APP_CONFIG);
  });

  it("honors the configured knobs", () => {
    expect(
      parseObsidianAppConfig(
        JSON.stringify({
          newLinkFormat: "relative",
          useMarkdownLinks: true,
          attachmentFolderPath: "assets",
        }),
      ),
    ).toEqual({
      newLinkFormat: "relative",
      useMarkdownLinks: true,
      attachmentFolderPath: "assets",
    });
  });

  it("rejects unknown knob values back to defaults", () => {
    expect(
      parseObsidianAppConfig(JSON.stringify({ newLinkFormat: "odd" })),
    ).toEqual(DEFAULT_OBSIDIAN_APP_CONFIG);
  });
});

describe("wikilink target resolution", () => {
  it("resolves an exact vault-root path with and without extension", () => {
    expect(resolveWikilinkTarget("garden-journal.md", context)).toEqual({
      kind: "note",
      path: "garden-journal.md",
    });
    expect(resolveWikilinkTarget("projects/greenhouse/frame", context)).toEqual(
      { kind: "note", path: "projects/greenhouse/frame.md" },
    );
  });

  it("resolves a bare name to the shortest matching path", () => {
    expect(resolveWikilinkTarget("garden-journal", context)).toEqual({
      kind: "note",
      path: "garden-journal.md",
    });
    expect(resolveWikilinkTarget("frame", context)).toEqual({
      kind: "note",
      path: "projects/greenhouse/frame.md",
    });
  });

  it("strips heading and block suffixes before resolving", () => {
    expect(
      resolveWikilinkTarget("garden-journal#Spring planting", context),
    ).toEqual({ kind: "note", path: "garden-journal.md" });
    expect(resolveWikilinkTarget("garden-journal#^row-seven", context)).toEqual(
      { kind: "note", path: "garden-journal.md" },
    );
  });

  it("treats an empty note part as a self reference", () => {
    expect(resolveWikilinkTarget("#Bare note link", context)).toEqual({
      kind: "self",
    });
    expect(resolveWikilinkTarget("#^para-anchor", context)).toEqual({
      kind: "self",
    });
  });

  it("matches case-insensitively and across Unicode normalization forms", () => {
    expect(resolveWikilinkTarget("weekly review notes", context)).toEqual({
      kind: "note",
      path: "notes/Weekly Review Notes.md",
    });
    // NFD-composed input resolves to the NFC-stored path.
    expect(resolveWikilinkTarget("café-notat", context)).toEqual({
      kind: "note",
      path: "café-notat.md",
    });
  });

  it("resolves attachment names for embeds", () => {
    expect(resolveWikilinkTarget("sketch-of-frame.png", context)).toEqual({
      kind: "note",
      path: "sketch-of-frame.png",
    });
  });

  it("reports unknown targets unresolved", () => {
    expect(resolveWikilinkTarget("no-such-note", context)).toEqual({
      kind: "unresolved",
    });
  });
});

describe("resolution feeds the decoration attributes", () => {
  function serialized(text: string): string {
    return serializeDecorationSet(
      computeDecorations({
        doc: Text.of(text.split("\n")),
        tree: skribeumMarkdownParser.parse(text),
        table: DECORATION_TABLE,
        wikilinks: context,
      }),
    );
  }

  it("stamps resolved and unresolved links distinctly", () => {
    const text = "See [[garden-journal]] and [[missing-note]] here.\n";
    const lines = serialized(text);
    expect(lines).toContain(
      'mark class="cm-skr-wikilink" data-resolved="true"',
    );
    expect(lines).toContain(
      'mark class="cm-skr-wikilink" data-resolved="false"',
    );
  });

  it("self references count as resolved", () => {
    const lines = serialized("A local [[#Heading ref]] link.\n");
    expect(lines).toContain(
      'mark class="cm-skr-wikilink" data-resolved="true"',
    );
  });
});
