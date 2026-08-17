// Criterion 10 (M2): typed frontmatter properties. The positional parser
// records the exact character range of every value, panel edits replace
// precisely that range through a normal editor transaction, and untouched
// keys are byte-preserved: the round-trip cases below drive an edit
// through a real EditorState change and compare every byte outside the
// declared range against the original.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import Editor from "../../src/lib/Editor.svelte";
import {
  decorationEngine,
  frontmatterAwareCursorUp,
  taskStatusConfiguration,
} from "../../src/lib/editor/decorations/engine";
import {
  applyTypeOverrides,
  parseFrontmatter,
  parseObsidianTypes,
  propertyInsertion,
  wikilinkValue,
} from "../../src/lib/editor/frontmatter";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import { obsidianMarkdownExtensionsFor } from "../../src/lib/editor/markdown/obsidian";
import type { LoadedNote } from "../../src/lib/ipc/vault";
import { DEFAULT_TASK_STATUSES } from "../../src/lib/taskStatuses";

const corpusDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "corpus",
);

const corpusText = readFileSync(
  path.join(corpusDirectory, "frontmatter-duplicate-keys.md"),
  "utf8",
);

/** Applies a single range replacement through a real editor transaction. */
function applyEdit(
  text: string,
  from: number,
  to: number,
  insert: string,
): string {
  return EditorState.create({ doc: text })
    .update({ changes: { from, to, insert } })
    .state.doc.toString();
}

describe("frontmatter parsing", () => {
  it("preserves key order and duplicate keys over the corpus file", () => {
    const frontmatter = parseFrontmatter(corpusText);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter?.entries.map((entry) => entry.key)).toEqual([
      "title",
      "title",
      "aliases",
      "tags",
      "author",
      "location",
      "summary",
      "rating",
      "published",
      "created",
      "weird spacing",
    ]);
  });

  it("every recorded range slices to exactly the raw value", () => {
    const frontmatter = parseFrontmatter(corpusText);
    expect(frontmatter).not.toBeNull();
    for (const entry of frontmatter?.entries ?? []) {
      expect(corpusText.slice(entry.keyFrom, entry.keyTo)).toBe(entry.key);
      expect(corpusText.slice(entry.valueFrom, entry.valueTo)).toBe(entry.raw);
      for (const item of entry.items ?? []) {
        expect(corpusText.slice(item.from, item.to)).toBe(item.raw);
      }
    }
  });

  it("types scalars from their values", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const byKey = new Map(
      frontmatter?.entries.map((entry) => [entry.key, entry]) ?? [],
    );
    expect(byKey.get("rating")?.type).toBe("number");
    expect(byKey.get("published")?.type).toBe("boolean");
    expect(byKey.get("created")?.type).toBe("date");
    expect(byKey.get("author")?.type).toBe("text");
    expect(byKey.get("aliases")?.type).toBe("list");
    expect(byKey.get("aliases")?.items?.map((item) => item.raw)).toEqual([
      "fjörður-glósa",
      "café-notat",
    ]);
  });

  it("parses flow lists with item ranges", () => {
    const text = "---\ntags: [alpha, beta-two, gamma]\n---\nbody\n";
    const frontmatter = parseFrontmatter(text);
    const tags = frontmatter?.entries[0];
    expect(tags?.type).toBe("list");
    expect(tags?.items?.map((item) => item.raw)).toEqual([
      "alpha",
      "beta-two",
      "gamma",
    ]);
    for (const item of tags?.items ?? []) {
      expect(text.slice(item.from, item.to)).toBe(item.raw);
    }
  });

  it("returns null without a closed leading fence", () => {
    expect(parseFrontmatter("no frontmatter\n")).toBeNull();
    expect(parseFrontmatter("---\ntitle: unterminated\n")).toBeNull();
    expect(parseFrontmatter("\n---\ntitle: not leading\n---\n")).toBeNull();
  });
});

describe("frontmatter round-trip byte preservation", () => {
  function assertOnlyRangeChanged(
    original: string,
    edited: string,
    from: number,
    to: number,
    insert: string,
  ) {
    expect(edited.slice(0, from)).toBe(original.slice(0, from));
    expect(edited.slice(from, from + insert.length)).toBe(insert);
    expect(edited.slice(from + insert.length)).toBe(original.slice(to));
  }

  it("a number edit rewrites only the value's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const rating = frontmatter?.entries.find((entry) => entry.key === "rating");
    expect(rating).toBeDefined();
    if (rating === undefined) {
      return;
    }
    const edited = applyEdit(corpusText, rating.valueFrom, rating.valueTo, "5");
    assertOnlyRangeChanged(
      corpusText,
      edited,
      rating.valueFrom,
      rating.valueTo,
      "5",
    );
    // The duplicate title keys, the oddly spaced key and every other line
    // survive byte-for-byte; the reparse sees the same key order.
    expect(edited).toContain(
      "weird spacing:    value with leading spaces preserved by some loaders",
    );
    expect(parseFrontmatter(edited)?.entries.map((entry) => entry.key)).toEqual(
      parseFrontmatter(corpusText)?.entries.map((entry) => entry.key),
    );
    expect(
      parseFrontmatter(edited)?.entries.find((entry) => entry.key === "rating")
        ?.raw,
    ).toBe("5");
  });

  it("a boolean edit rewrites only the value's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const published = frontmatter?.entries.find(
      (entry) => entry.key === "published",
    );
    expect(published?.raw).toBe("false");
    if (published === undefined) {
      return;
    }
    const edited = applyEdit(
      corpusText,
      published.valueFrom,
      published.valueTo,
      "true",
    );
    assertOnlyRangeChanged(
      corpusText,
      edited,
      published.valueFrom,
      published.valueTo,
      "true",
    );
  });

  it("a list item edit rewrites only that item's bytes", () => {
    const frontmatter = parseFrontmatter(corpusText);
    const aliases = frontmatter?.entries.find(
      (entry) => entry.key === "aliases",
    );
    const second = aliases?.items?.[1];
    expect(second?.raw).toBe("café-notat");
    if (second === undefined) {
      return;
    }
    const edited = applyEdit(corpusText, second.from, second.to, "té-notat");
    assertOnlyRangeChanged(
      corpusText,
      edited,
      second.from,
      second.to,
      "té-notat",
    );
    expect(
      parseFrontmatter(edited)
        ?.entries.find((entry) => entry.key === "aliases")
        ?.items?.map((item) => item.raw),
    ).toEqual(["fjörður-glósa", "té-notat"]);
  });
});

describe("declared Obsidian property types (decision 101)", () => {
  it("maps types.json declarations onto panel types", () => {
    const overrides = parseObsidianTypes(
      JSON.stringify({
        types: {
          published: "checkbox",
          created: "datetime",
          aliases: "multitext",
          rating: "number",
          summary: "unknown-kind",
        },
      }),
    );
    expect(overrides).toEqual({
      published: "boolean",
      created: "date",
      aliases: "list",
      rating: "number",
    });
  });

  it("declared types win only when the value can edit as that type", () => {
    const text = "---\ncount: not-a-number\nflag: true\n---\n";
    const frontmatter = parseFrontmatter(text);
    expect(frontmatter).not.toBeNull();
    if (frontmatter === null) {
      return;
    }
    const applied = applyTypeOverrides(frontmatter, {
      count: "number",
      flag: "text",
    });
    // A declared number over a non-numeric value stays text.
    expect(applied.entries.find((entry) => entry.key === "count")?.type).toBe(
      "text",
    );
    // A declared text over a boolean is honored.
    expect(applied.entries.find((entry) => entry.key === "flag")?.type).toBe(
      "text",
    );
  });

  it("tolerates malformed types.json", () => {
    expect(parseObsidianTypes("not json")).toEqual({});
    expect(parseObsidianTypes("[]")).toEqual({});
  });
});

describe("wikilink-shaped property values (section 4.15)", () => {
  it("reads a bare wikilink value", () => {
    expect(wikilinkValue("[[Reading room]]")).toEqual({
      target: "Reading room",
      label: "Reading room",
    });
  });

  it("reads an aliased wikilink with a fragment", () => {
    expect(wikilinkValue('"[[Notes/Plan#Goals|the plan]]"')).toEqual({
      target: "Notes/Plan#Goals",
      label: "the plan",
    });
  });

  it("rejects non-wikilink values", () => {
    expect(wikilinkValue("plain text")).toBeNull();
    expect(wikilinkValue("[[]]")).toBeNull();
    expect(wikilinkValue("[[a]] and [[b]]")).toBeNull();
  });
});

describe("add-property insertion (section 4.15)", () => {
  it("appends a property line before the closing fence", () => {
    const text = "---\ntitle: One\n---\nBody\n";
    const parsed = parseFrontmatter(text);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    const insertion = propertyInsertion(parsed, "status", "draft");
    expect(insertion).not.toBeNull();
    if (insertion === null) return;
    const edited = applyEdit(
      text,
      insertion.from,
      insertion.from,
      insertion.insert,
    );
    expect(edited).toBe("---\ntitle: One\nstatus: draft\n---\nBody\n");
    const reparsed = parseFrontmatter(edited);
    expect(reparsed?.entries.map((entry) => entry.key)).toEqual([
      "title",
      "status",
    ]);
  });

  it("normalizes keys and rejects empty ones", () => {
    const parsed = parseFrontmatter("---\n---\n");
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(propertyInsertion(parsed, "  ", "x")).toBeNull();
    expect(propertyInsertion(parsed, "my key:", "a\nb")?.insert).toBe(
      "my-key: a b\n",
    );
  });
});

function loadedNote(text: string): LoadedNote {
  const bytes = new TextEncoder().encode(text);
  return {
    meta: {
      encoding: "utf8",
      projection_hash: "0".repeat(64),
      byte_length: bytes.length,
    },
    bytes,
    text,
    readOnly: false,
  };
}

describe("properties panel spacing (computed geometry)", () => {
  // The hidden frontmatter lines collapse to zero height (display:none), so
  // the only remaining candidate for the reported "large empty band" is the
  // editor's own first-block top padding stacking beneath the panel's
  // hairline. These assertions read the cascade's actual resolved value
  // (getComputedStyle), not a class name or a rendered snapshot, so a rule
  // that stops applying fails the test even though every element and class
  // still renders.
  it("removes the editor's own top padding under a collapsed properties panel", async () => {
    const source = [
      "---",
      "title: Frontmatter demonstration",
      "---",
      "",
      "# Frontmatter",
      "",
      "Body text.",
      "",
    ].join("\n");
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(Editor, {
      target: host,
      props: { note: loadedNote(source), path: "frontmatter.md" },
    });
    flushSync();
    try {
      const properties = host.querySelector(".skr-properties");
      expect(properties).not.toBeNull();
      const content = host.querySelector(".cm-content") as HTMLElement;
      expect(getComputedStyle(content).paddingTop).toBe("0px");
    } finally {
      await unmount(component);
      host.remove();
    }
  });

  it("keeps the normal top padding for a note without frontmatter", async () => {
    const source = ["# Heading", "", "Body text.", ""].join("\n");
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(Editor, {
      target: host,
      props: { note: loadedNote(source), path: "plain.md" },
    });
    flushSync();
    try {
      expect(host.querySelector(".skr-properties")).toBeNull();
      const content = host.querySelector(".cm-content") as HTMLElement;
      expect(getComputedStyle(content).paddingTop).not.toBe("0px");
    } finally {
      await unmount(component);
      host.remove();
    }
  });

  it("restores the top padding once the frontmatter block itself is revealed", async () => {
    const source = [
      "---",
      "title: Frontmatter demonstration",
      "---",
      "",
      "# Frontmatter",
      "",
      "Body text.",
      "",
    ].join("\n");
    const host = document.createElement("div");
    document.body.append(host);
    const component = mount(Editor, {
      target: host,
      props: { note: loadedNote(source), path: "frontmatter.md" },
    });
    flushSync();
    try {
      const view = component.getView();
      expect(view).toBeDefined();
      if (view === undefined) return;
      // Focus first: reveal additionally requires focused editing intent
      // (section on the parked caret), matching real keyboard entry rather
      // than a passive, unfocused selection restore.
      view.contentDOM.focus();
      view.dispatch({ selection: { anchor: source.indexOf("title") } });
      flushSync();
      const content = host.querySelector(".cm-content") as HTMLElement;
      expect(getComputedStyle(content).paddingTop).not.toBe("0px");
    } finally {
      await unmount(component);
      host.remove();
    }
  });
});

function mountedView(doc: string, anchor: number): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(DEFAULT_TASK_STATUSES),
          codeLanguages: codeLanguage,
        }),
        taskStatusConfiguration.of(DEFAULT_TASK_STATUSES),
        decorationEngine(),
      ],
    }),
    parent: document.body,
  });
}

describe("ArrowUp cursor motion above hidden frontmatter", () => {
  const views: EditorView[] = [];

  afterEach(() => {
    for (const view of views.splice(0)) {
      view.destroy();
    }
    document.body.textContent = "";
  });

  // The frontmatter block always starts at document position 0. CodeMirror's
  // generic atomic-range clamp pushes an upward move to the obstacle's near
  // edge, which for this block is position 0 itself: still inside the
  // hidden, display:none text, not a position the DOM can show a caret in.
  // `frontmatterAwareCursorUp` is the guard that corrects this; these cases
  // exercise it directly (selection-position assertions) rather than through
  // a real ArrowUp keypress, whose own pixel geometry jsdom cannot render.
  const doc =
    "---\ntitle: Frontmatter demonstration\n---\n\n# Frontmatter\n\nBody text.\n";
  const blankLineAboveHeading = doc.indexOf("\n\n# Frontmatter") + 1;

  it("holds the caret at the first visible line instead of the hidden block", () => {
    const view = mountedView(doc, blankLineAboveHeading);
    views.push(view);
    const handled = frontmatterAwareCursorUp(view);
    expect(handled).toBe(true);
    expect(view.state.selection.main.head).toBe(blankLineAboveHeading);
  });

  it("never lands the caret inside the hidden frontmatter range", () => {
    const view = mountedView(doc, blankLineAboveHeading);
    views.push(view);
    frontmatterAwareCursorUp(view);
    const head = view.state.selection.main.head;
    const frontmatterEnd = doc.indexOf("\n\n# Frontmatter");
    expect(head === 0 || (head > 0 && head < frontmatterEnd)).toBe(false);
  });

  it("passes through when the cursor is not on the boundary line", () => {
    // Elsewhere in the document (here, the heading itself) the guard has
    // nothing to correct and must not claim the key, so a handler bound at
    // lower precedence (such as table cell navigation) still gets a chance.
    const headingPosition = doc.indexOf("# Frontmatter") + 2;
    const view = mountedView(doc, headingPosition);
    views.push(view);
    const handled = frontmatterAwareCursorUp(view);
    expect(handled).toBe(false);
    expect(view.state.selection.main.head).toBe(headingPosition);
  });

  it("passes through once the frontmatter block is itself revealed", () => {
    const view = mountedView(doc, doc.indexOf("title"));
    views.push(view);
    expect(
      view.state.facet(EditorView.atomicRanges).flatMap((f) => {
        const ranges: [number, number][] = [];
        const cursor = f(view).iter();
        while (cursor.value !== null) {
          ranges.push([cursor.from, cursor.to]);
          cursor.next();
        }
        return ranges;
      }),
    ).toEqual([]);
    expect(frontmatterAwareCursorUp(view)).toBe(false);
  });

  it("passes through far from any frontmatter block", () => {
    const plainDoc = "# H\n\npara one\n\npara two\n\npara three\n";
    const position = plainDoc.indexOf("para three") + 2;
    const view = mountedView(plainDoc, position);
    views.push(view);
    const handled = frontmatterAwareCursorUp(view);
    expect(handled).toBe(false);
    expect(view.state.selection.main.head).toBe(position);
  });

  it("registers the hidden block as one atomic range for CodeMirror's own motion", () => {
    const view = mountedView(doc, blankLineAboveHeading);
    views.push(view);
    const frontmatterEnd = doc.indexOf("\n\n# Frontmatter");
    const ranges = view.state.facet(EditorView.atomicRanges).flatMap((f) => {
      const out: [number, number][] = [];
      const cursor = f(view).iter();
      while (cursor.value !== null) {
        out.push([cursor.from, cursor.to]);
        cursor.next();
      }
      return out;
    });
    expect(ranges).toContainEqual([0, frontmatterEnd]);
  });
});
