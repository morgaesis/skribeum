import { describe, expect, it } from "vitest";
import {
  CALLOUT_ALIASES,
  type CalloutAccentGroup,
  type CalloutCanonicalType,
  calloutIconSvg,
  parseCallout,
  resolveCalloutType,
} from "../../src/lib/editor/decorations/callouts";

const TAXONOMY: ReadonlyArray<{
  aliases: readonly string[];
  canonicalType: CalloutCanonicalType;
  accentGroup: CalloutAccentGroup;
}> = [
  { aliases: ["note"], canonicalType: "note", accentGroup: "blue" },
  {
    aliases: ["abstract", "summary", "tldr"],
    canonicalType: "abstract",
    accentGroup: "cyan",
  },
  { aliases: ["info"], canonicalType: "info", accentGroup: "blue" },
  { aliases: ["todo"], canonicalType: "todo", accentGroup: "blue" },
  {
    aliases: ["tip", "hint", "important"],
    canonicalType: "tip",
    accentGroup: "cyan",
  },
  {
    aliases: ["success", "check", "done"],
    canonicalType: "success",
    accentGroup: "green",
  },
  {
    aliases: ["question", "help", "faq"],
    canonicalType: "question",
    accentGroup: "yellow",
  },
  {
    aliases: ["warning", "caution", "attention"],
    canonicalType: "warning",
    accentGroup: "orange",
  },
  {
    aliases: ["failure", "fail", "missing"],
    canonicalType: "failure",
    accentGroup: "red",
  },
  {
    aliases: ["danger", "error"],
    canonicalType: "danger",
    accentGroup: "red",
  },
  { aliases: ["bug"], canonicalType: "bug", accentGroup: "red" },
  {
    aliases: ["example"],
    canonicalType: "example",
    accentGroup: "purple",
  },
  {
    aliases: ["quote", "cite"],
    canonicalType: "quote",
    accentGroup: "gray",
  },
];

describe("callout taxonomy", () => {
  it("covers every Obsidian type and alias", () => {
    const expectedAliases = TAXONOMY.flatMap(({ aliases }) => aliases).sort();
    expect(Object.keys(CALLOUT_ALIASES).sort()).toEqual(expectedAliases);

    for (const { aliases, canonicalType, accentGroup } of TAXONOMY) {
      for (const alias of aliases) {
        expect(resolveCalloutType(alias)).toMatchObject({
          originalType: alias,
          canonicalType,
          accentGroup,
        });
      }
    }
  });

  it("resolves aliases without losing original spelling or useful titles", () => {
    expect(resolveCalloutType("TLDR")).toEqual({
      originalType: "TLDR",
      canonicalType: "abstract",
      accentGroup: "cyan",
      defaultTitle: "TLDR",
    });
    expect(resolveCalloutType("custom-review")).toEqual({
      originalType: "custom-review",
      canonicalType: "note",
      accentGroup: "blue",
      defaultTitle: "Custom Review",
    });
  });
});

describe("callout source parsing", () => {
  it("extracts a custom title and removes one blockquote prefix per body line", () => {
    expect(
      parseCallout(
        "> [!warning] Deployment check\n> Review the **diff**.\n>\n> > Keep this nested quote.\nUnquoted lazy continuation",
      ),
    ).toMatchObject({
      originalType: "warning",
      canonicalType: "warning",
      accentGroup: "orange",
      defaultTitle: "Warning",
      title: "Deployment check",
      foldable: false,
      initiallyExpanded: true,
      bodyMarkdown:
        "Review the **diff**.\n\n> Keep this nested quote.\nUnquoted lazy continuation",
    });
  });

  it.each([
    ["-", false],
    ["+", true],
  ] as const)("parses the %s fold marker", (marker, initiallyExpanded) => {
    const callout = parseCallout(
      `> [!summary]${marker}\n> First line\n> Second line`,
    );
    expect(callout).toMatchObject({
      canonicalType: "abstract",
      defaultTitle: "Summary",
      title: "Summary",
      foldable: true,
      initiallyExpanded,
      bodyMarkdown: "First line\nSecond line",
    });
  });

  it("preserves body line endings and markdown content", () => {
    const callout = parseCallout(
      "  > [!tip]\r\n  > `code`  \r\n  > - item\r\n",
    );
    expect(callout?.bodyMarkdown).toBe("`code`  \r\n- item\r\n");
  });

  it("falls back to note visuals for unknown types", () => {
    expect(parseCallout("> [!Release_Status]\n> Pending")).toMatchObject({
      originalType: "Release_Status",
      canonicalType: "note",
      accentGroup: "blue",
      defaultTitle: "Release Status",
      title: "Release Status",
      bodyMarkdown: "Pending",
    });
  });

  it("returns null for ordinary and malformed blockquotes", () => {
    expect(parseCallout("> Ordinary quote")).toBeNull();
    expect(parseCallout("> text [!note]")).toBeNull();
    expect(parseCallout("[!note]\nBody without a blockquote")).toBeNull();
    expect(parseCallout("> [NOTE]- Missing marker")).toBeNull();
  });
});

describe("callout icons", () => {
  it("provides distinct, inert SVG markup for every canonical type", () => {
    const canonicalTypes = TAXONOMY.map(({ canonicalType }) => canonicalType);
    const icons = canonicalTypes.map((type) => calloutIconSvg(type));
    expect(new Set(icons).size).toBe(canonicalTypes.length);

    for (const icon of icons) {
      const host = document.createElement("span");
      host.innerHTML = icon;
      const svg = host.querySelector("svg.cm-skr-callout-icon");
      expect(svg).not.toBeNull();
      expect(svg?.getAttribute("viewBox")).toBe("0 0 24 24");
      expect(svg?.getAttribute("aria-hidden")).toBe("true");
      expect(svg?.getAttribute("focusable")).toBe("false");
      expect(svg?.querySelector("path, circle, rect")).not.toBeNull();
      expect(svg?.querySelector("script, foreignObject")).toBeNull();
    }
  });

  it("uses the note icon for unknown types", () => {
    expect(calloutIconSvg("custom")).toBe(calloutIconSvg("note"));
  });
});
