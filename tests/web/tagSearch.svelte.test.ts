// Tag mode of the unified command surface, asserted on what a reader sees:
// the rendered rows and their order, the colour they are drawn in, the name
// a screen reader speaks, and which row a keypress lands on. The matcher is
// driven through the mounted surface rather than called directly, because the
// defects this covers lived between the matcher and the screen.

import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it } from "vitest";
import { type PickerItem, tagItems } from "../../src/lib/features/pickers";
import UnifiedCommandSurface from "../../src/lib/UnifiedCommandSurface.svelte";

type Catalog = readonly {
  tag: string;
  noteCount: number;
  occurrenceCount: number;
}[];

const VAULT: Catalog = [
  { tag: "feature", noteCount: 6, occurrenceCount: 9 },
  { tag: "feature/callouts", noteCount: 2, occurrenceCount: 2 },
  { tag: "feature/tables", noteCount: 11, occurrenceCount: 20 },
  { tag: "feature/tables/wide", noteCount: 3, occurrenceCount: 3 },
  { tag: "features", noteCount: 1, occurrenceCount: 1 },
  { tag: "docs/feature-notes", noteCount: 4, occurrenceCount: 4 },
  { tag: "unfeatured", noteCount: 5, occurrenceCount: 5 },
  { tag: "featrues", noteCount: 7, occurrenceCount: 7 },
  { tag: "unrelated", noteCount: 30, occurrenceCount: 40 },
];

let mounted: ReturnType<typeof mount> | undefined;

function open(catalog: Catalog, query: string, recentTags: string[] = []) {
  const props = $state({
    items: tagItems(catalog, query, recentTags) as PickerItem[],
    mode: "tag" as const,
    initialQuery: `#${query}`,
    onQueryChange: () => {},
    onPick: () => {},
    onClose: () => {},
    restoreFocus: false,
  });
  mounted = mount(UnifiedCommandSurface, { target: document.body, props });
  flushSync();
  return props;
}

function rowTexts(): string[] {
  return [...document.body.querySelectorAll('[role="option"]')].map(
    (option) => option.querySelector(".min-w-0")?.textContent?.trim() ?? "",
  );
}

function groupOf(text: string): string | null {
  for (const option of document.body.querySelectorAll('[role="option"]')) {
    if (option.querySelector(".min-w-0")?.textContent?.trim() === text) {
      return option.getAttribute("data-result-group");
    }
  }
  return null;
}

function press(key: string): void {
  document.body
    .querySelector('[role="combobox"]')
    ?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  flushSync();
}

function selectedText(): string | undefined {
  return (
    document.body
      .querySelector('[aria-selected="true"] .min-w-0')
      ?.textContent?.trim() ?? undefined
  );
}

afterEach(() => {
  if (mounted !== undefined) {
    void unmount(mounted);
    mounted = undefined;
  }
  document.body.replaceChildren();
});

describe("tag mode query syntax", () => {
  it.each(["feature", "feature*", "*feature", "f*e*a*t*u*r*e"])(
    "reads %s as the same query",
    (query) => {
      open(VAULT, query);
      const rows = rowTexts();
      expect(rows.length).toBeGreaterThan(1);
      void unmount(mounted as ReturnType<typeof mount>);
      mounted = undefined;
      document.body.replaceChildren();

      open(VAULT, "feature");
      expect(rows).toEqual(rowTexts());
    },
  );

  it("names the effective query after a wildcard is removed", () => {
    open(VAULT, "zzz*x");
    expect(document.body.textContent).toContain('No tag matches "zzzx"');
    expect(document.body.textContent).not.toContain("zzz*x");
  });
});

describe("tag mode bands and order", () => {
  it("leads with the exact tag, then descendants, then prefixes", () => {
    open(VAULT, "feature");

    expect(rowTexts().slice(0, 6)).toEqual([
      "#feature",
      "#feature/tables",
      "#feature/callouts",
      "#feature/tables/wide",
      "#features",
      "#docs/feature-notes",
    ]);
  });

  it("orders by how many notes use a tag, not by the alphabet", () => {
    // "tables" sorts after "callouts" alphabetically and is used in more
    // notes, so usage has to be what decides.
    open(VAULT, "feature");
    const order = rowTexts();
    expect(order.indexOf("#feature/tables")).toBeLessThan(
      order.indexOf("#feature/callouts"),
    );
  });

  it("keeps a direct child above a grandchild", () => {
    open(VAULT, "feature");
    const order = rowTexts();
    expect(order.indexOf("#feature/tables")).toBeLessThan(
      order.indexOf("#feature/tables/wide"),
    );
  });

  it("never lists a tag twice and never repeats an order", () => {
    open(VAULT, "feature");
    const first = rowTexts();
    expect(new Set(first).size).toBe(first.length);
    void unmount(mounted as ReturnType<typeof mount>);
    mounted = undefined;
    document.body.replaceChildren();

    open(VAULT, "feature");
    expect(rowTexts()).toEqual(first);
  });

  it("returns nothing reachable only by skipping characters", () => {
    open(VAULT, "fte");
    expect(rowTexts().filter((text) => text.startsWith("#"))).toEqual([]);
  });

  it("states a note count on every tag row", () => {
    open(VAULT, "feature");
    for (const option of document.body.querySelectorAll(
      '[role="option"][data-result-kind="tag"]',
    )) {
      expect(option.textContent?.trim()).toMatch(/\d+ notes?$/u);
    }
  });
});

describe("tag mode near matches", () => {
  it("groups a typo and a containing tag below the answers", () => {
    open(VAULT, "feature");

    expect(groupOf("#unfeatured")).toBe("Near matches");
    expect(groupOf("#featrues")).toBe("Near matches");
    expect(groupOf("#feature")).toBe("Tags");
    // Nothing above the boundary reappears below it.
    const near = [...document.body.querySelectorAll('[role="option"]')].filter(
      (option) => option.getAttribute("data-result-group") === "Near matches",
    );
    const primary = [
      ...document.body.querySelectorAll('[role="option"]'),
    ].filter((option) => option.getAttribute("data-result-group") === "Tags");
    expect(near.filter((option) => primary.includes(option))).toHaveLength(0);
  });

  it("finds the tag behind a transposition and not the long path", () => {
    open(
      [
        { tag: "feature", noteCount: 6, occurrenceCount: 9 },
        { tag: "feature/long-document", noteCount: 1, occurrenceCount: 1 },
      ],
      "featrue",
    );

    expect(rowTexts().filter((text) => text.startsWith("#"))).toEqual([
      "#feature",
    ]);
    expect(groupOf("#feature")).toBe("Near matches");
  });

  it("offers no typo row for a two-character query", () => {
    open([{ tag: "ab", noteCount: 1, occurrenceCount: 1 }], "ac");
    expect(rowTexts().filter((text) => text.startsWith("#"))).toEqual([]);
  });

  it("never accepts a typo in the first character", () => {
    open([{ tag: "gamma", noteCount: 1, occurrenceCount: 1 }], "damma");
    expect(rowTexts().filter((text) => text.startsWith("#"))).toEqual([]);
  });

  it("never grows the near-match group past five rows", () => {
    const catalog = Array.from({ length: 20 }, (_, index) => ({
      tag: `alpha-${index}`,
      noteCount: index + 1,
      occurrenceCount: index + 1,
    }));
    open(catalog, "lpha");

    expect(
      [...document.body.querySelectorAll('[role="option"]')].filter(
        (option) => option.getAttribute("data-result-group") === "Near matches",
      ),
    ).toHaveLength(5);
  });

  it("draws a near match in the muted colour and a primary row in the text colour", () => {
    open(VAULT, "feature");
    const rows = [...document.body.querySelectorAll('[role="option"]')];
    const primary = rows.find(
      (option) => option.getAttribute("data-result-group") === "Tags",
    );
    const near = rows.find(
      (option) => option.getAttribute("data-result-group") === "Near matches",
    );

    const primaryColor = getComputedStyle(primary as HTMLElement).color;
    const nearColor = getComputedStyle(near as HTMLElement).color;
    expect(primaryColor).not.toBe("");
    expect(nearColor).not.toBe(primaryColor);
  });

  it("marks the typed span on a match and marks nothing on a typo", () => {
    open(VAULT, "feature");
    const rows = [...document.body.querySelectorAll('[role="option"]')];
    const exact = rows.find(
      (option) =>
        option.querySelector(".min-w-0")?.textContent?.trim() === "#feature",
    );
    const typo = rows.find(
      (option) =>
        option.querySelector(".min-w-0")?.textContent?.trim() === "#featrues",
    );

    expect(exact?.querySelector("mark")?.textContent).toBe("feature");
    expect(typo?.querySelector("mark")).toBeNull();
  });

  it("speaks a near-match row as one, with its note count", () => {
    open(VAULT, "feature");
    const near = [...document.body.querySelectorAll('[role="option"]')].find(
      (option) =>
        option.querySelector(".min-w-0")?.textContent?.trim() === "#featrues",
    );

    expect(near?.getAttribute("aria-label")).toBe(
      "#featrues, near match, 7 notes",
    );
  });
});

describe("tag mode keyboard", () => {
  it("selects a primary row on opening and crosses into near matches by arrow", () => {
    open(VAULT, "feature");
    expect(selectedText()).toBe("#feature");
    expect(
      document.body
        .querySelector('[aria-selected="true"]')
        ?.getAttribute("data-result-group"),
    ).toBe("Tags");

    const order = rowTexts();
    const firstNear = order.indexOf("#unfeatured");
    for (let step = 0; step < firstNear; step += 1) {
      press("ArrowDown");
    }
    expect(selectedText()).toBe("#unfeatured");
  });

  it("does not wrap at the end of the list", () => {
    open(VAULT, "feature");
    const last = rowTexts().at(-1);
    for (let step = 0; step < 40; step += 1) {
      press("ArrowDown");
    }
    expect(selectedText()).toBe(last);
    press("ArrowDown");
    expect(selectedText()).toBe(last);
  });

  it("moves Home to the first row and End to the last", () => {
    open(VAULT, "feature");
    const order = rowTexts();
    press("End");
    expect(selectedText()).toBe(order.at(-1));
    press("Home");
    expect(selectedText()).toBe(order[0]);
  });
});

describe("tag mode empty states and bounds", () => {
  it("names the act that creates a tag when the vault has none", () => {
    open([], "anything");
    expect(document.body.textContent).toContain(
      "Write #name anywhere in a note",
    );
    expect(document.body.querySelectorAll('[role="option"]')).toHaveLength(0);
  });

  it("offers a note-text search when nothing matched, and selects it", () => {
    open(VAULT, "zzz");
    expect(document.body.textContent).toContain('No tag matches "zzz"');
    expect(selectedText()).toBe("Search note text for zzz");
  });

  it("ends a truncated list with a count that cannot be selected", () => {
    const catalog = Array.from({ length: 40 }, (_, index) => ({
      tag: `wide-${index.toString().padStart(2, "0")}`,
      noteCount: 1,
      occurrenceCount: 1,
    }));
    open(catalog, "wide");

    expect(
      document.body.querySelectorAll('[role="option"][data-result-kind="tag"]'),
    ).toHaveLength(25);
    const countRow = [...document.body.querySelectorAll("li")].find((row) =>
      row.textContent?.includes("15 more tags match"),
    );
    expect(countRow).toBeDefined();
    // Not an option at all, so no keypress can reach it and Enter has
    // nothing to invoke on it.
    expect(countRow?.getAttribute("role")).toBe("presentation");
    for (let step = 0; step < 60; step += 1) {
      press("ArrowDown");
      expect(countRow?.getAttribute("aria-selected")).toBeNull();
    }
    expect(selectedText()).toBe("Search note text for wide");
  });

  it("shows recent tags then the most used ones with nothing typed", () => {
    open(VAULT, "", ["unrelated"]);

    expect(groupOf("#unrelated")).toBe("Recent");
    expect(groupOf("#feature/tables")).toBe("Most used");
    expect(rowTexts()[0]).toBe("#unrelated");
    expect(rowTexts()[1]).toBe("#feature/tables");
  });

  it("answers a keystroke over five thousand tags in a few passes over them", () => {
    const catalog = Array.from({ length: 5000 }, (_, index) => ({
      tag: `topic-${index}/sub-${index % 17}`,
      noteCount: index % 40,
      occurrenceCount: index % 40,
    }));
    const typed = "topic-4";
    const keystrokes = Array.from({ length: typed.length }, (_value, index) =>
      typed.slice(0, index + 1),
    );
    // Reading every tag once is the floor: no matcher can answer a keystroke
    // without looking at each candidate. Measuring against that floor in the
    // same process states the property a frame budget is a proxy for, and
    // says it in a way that does not depend on how fast this machine is.
    //
    // The floor is timed over as many passes as the budget allows rather than
    // over one, so the two timed windows are of comparable length. A single
    // pass runs in a fraction of the time a keystroke takes, and a scheduler
    // pause on a loaded machine is correspondingly likelier to land inside
    // the longer window than the shorter one, which turns the ratio between
    // them into a measurement of contention rather than of the matcher.
    const PASSES = 6;
    const floor = () => {
      const started = performance.now();
      for (let pass = 0; pass < PASSES; pass += 1) {
        const seen = new Set<string>();
        for (const entry of catalog) {
          seen.add(entry.tag.toLowerCase());
        }
        expect(seen.size).toBe(catalog.length);
      }
      return performance.now() - started;
    };
    const keystroke = (query: string) => {
      const started = performance.now();
      const items = tagItems(catalog, query, []);
      const elapsed = performance.now() - started;
      expect(items.length).toBeGreaterThan(0);
      // Rendering cost stays flat however large the vault: the bands are
      // bounded, so the row count is too.
      expect(items.length).toBeLessThanOrEqual(32);
      return elapsed;
    };
    // A collection pause lands on whichever sample it lands on, so each
    // measurement is the fastest of a few and both sides are measured the
    // same way.
    const fastest = (measure: () => number) =>
      Math.min(measure(), measure(), measure());
    for (let warm = 0; warm < 5; warm += 1) {
      floor();
      for (const query of keystrokes) {
        keystroke(query);
      }
    }

    const reference = fastest(floor);
    const worst = Math.max(
      ...keystrokes.map((query) => fastest(() => keystroke(query))),
    );

    expect(worst).toBeLessThan(reference);
  });
});
