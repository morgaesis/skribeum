// Images, footnotes, thematic breaks and quote-block editing, asserted on
// what the surface actually produces: the element that carries the image,
// the resolved style the cascade gives a rendered footnote, the separator
// that replaces a delimiter, and the document text an edit leaves behind.
// Nothing here compares the engine's output to itself.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import {
  decorationEngine,
  taskStatusConfiguration,
  tokenHighlightStyle,
} from "../../src/lib/editor/decorations/engine";
import {
  imageMediaType,
  resolveImageSource,
} from "../../src/lib/editor/decorations/images";
import type { WikilinkResolutionContext } from "../../src/lib/editor/decorations/wikilinks";
import { EMPTY_WIKILINK_CONTEXT } from "../../src/lib/editor/decorations/wikilinks";
import { codeLanguage } from "../../src/lib/editor/markdown/codeLanguages";
import {
  obsidianMarkdownExtensionsFor,
  skribeumMarkdownParser,
} from "../../src/lib/editor/markdown/obsidian";
import {
  doublesQuoteMarker,
  quoteEditing,
} from "../../src/lib/editor/quoteEditing";
import { DEFAULT_TASK_STATUSES } from "../../src/lib/taskStatuses";

const views: EditorView[] = [];

// jsdom has no image pipeline and no object-URL store, so the environment
// supplies the two primitives the widget hands its bytes to. Everything the
// assertions read (the element, its accessible name, its resolved style)
// is still the surface's own output.
const images = new Map<string, string>();
let objectUrlCount = 0;
URL.createObjectURL = (blob: Blob) => {
  objectUrlCount += 1;
  const url = `blob:test/${objectUrlCount}`;
  images.set(url, blob.type);
  return url;
};
URL.revokeObjectURL = (url: string) => {
  images.delete(url);
};
HTMLImageElement.prototype.decode = function decode(this: HTMLImageElement) {
  return images.has(this.src)
    ? Promise.resolve()
    : Promise.reject(new Error("no such image"));
};

const PIXEL_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"></svg>';

function vaultContext(
  files: Readonly<Record<string, string>>,
): WikilinkResolutionContext {
  return {
    ...EMPTY_WIKILINK_CONTEXT,
    paths: Object.keys(files),
    currentPath: "note.md",
    loadAsset: (path: string) => {
      const body = files[path];
      return Promise.resolve(
        body === undefined ? null : new TextEncoder().encode(body),
      );
    },
  };
}

function mountedView(
  doc: string,
  cursor = doc.length,
  context: WikilinkResolutionContext = EMPTY_WIKILINK_CONTEXT,
  extra: readonly unknown[] = [],
): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: cursor },
      extensions: [
        markdown({
          base: markdownLanguage,
          extensions: obsidianMarkdownExtensionsFor(DEFAULT_TASK_STATUSES),
          codeLanguages: codeLanguage,
        }),
        syntaxHighlighting(tokenHighlightStyle, { fallback: true }),
        taskStatusConfiguration.of(DEFAULT_TASK_STATUSES),
        decorationEngine(context),
        ...(extra as never[]),
      ],
    }),
    parent: document.body,
  });
  views.push(view);
  return view;
}

async function waitFor<T extends Element>(
  root: ParentNode,
  selector: string,
): Promise<T> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const element = root.querySelector<T>(selector);
    if (element !== null) {
      return element;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`element did not render: ${selector}`);
}

/** The document node names produced for a source, in document order. */
function nodeNames(source: string): string[] {
  const names: string[] = [];
  skribeumMarkdownParser.parse(source).iterate({
    enter(ref) {
      names.push(ref.name);
      return undefined;
    },
  });
  return names;
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.dom.remove();
    view.destroy();
  }
  document.body.replaceChildren();
});

describe("standard Markdown images", () => {
  it("renders a vault image as an image element named by its alt text", async () => {
    const context = vaultContext({ "figure.svg": PIXEL_SVG });
    const view = mountedView("text\n\n![A figure](figure.svg)\n", 0, context);
    const image = await waitFor<HTMLImageElement>(
      view.contentDOM,
      "img.cm-skr-image-frame",
    );
    expect(image.alt).toBe("A figure");
    expect(image.src.startsWith("blob:")).toBe(true);
    // The blob is typed from the extension allowlist, never from content.
    expect(images.get(image.src)).toBe("image/svg+xml");
    // The frame scales down to the reading column rather than widening it.
    expect(getComputedStyle(image).maxWidth).toBe("100%");
  });

  it("names an image written without alt text by its file name", async () => {
    const context = vaultContext({ "assets/figure.svg": PIXEL_SVG });
    const view = mountedView("text\n\n![](assets/figure.svg)\n", 0, context);
    const image = await waitFor<HTMLImageElement>(
      view.contentDOM,
      "img.cm-skr-image-frame",
    );
    expect(image.alt).toBe("figure.svg");
  });

  it("reports a target the vault does not contain instead of leaving a gap", async () => {
    const view = mountedView(
      "text\n\n![Absent](missing.png)\n",
      0,
      vaultContext({ "other.png": "" }),
    );
    const host = await waitFor<HTMLElement>(
      view.contentDOM,
      ".cm-skr-image[data-image-source='missing']",
    );
    const body = await waitFor<HTMLElement>(
      host,
      ".cm-skr-image-body[data-loading-state='failure']",
    );
    expect(body.textContent).toContain("Couldn't load");
    expect(body.querySelector("button")).not.toBeNull();
    // The failure keeps the frame and turns its leading rule to danger.
    expect(getComputedStyle(body).borderLeftColor).toContain("--skr-danger");
  });

  it("returns the source while the caret is inside the image", async () => {
    const context = vaultContext({ "figure.svg": PIXEL_SVG });
    const source = "text\n\n![A figure](figure.svg)\n";
    const view = mountedView(source, 0, context);
    await waitFor(view.contentDOM, "img.cm-skr-image-frame");
    view.dispatch({ selection: { anchor: source.indexOf("figure.svg") } });
    expect(view.contentDOM.querySelector("img.cm-skr-image-frame")).toBeNull();
    expect(view.contentDOM.textContent).toContain("![A figure](figure.svg)");
  });

  it("keeps the link presentation for a target it does not render", () => {
    const view = mountedView("text\n\n![doc](notes/other.md)\n", 0);
    expect(view.contentDOM.querySelector(".cm-skr-image")).toBeNull();
    expect(view.contentDOM.querySelector(".cm-skr-link")).not.toBeNull();
  });

  describe("safety", () => {
    it("never puts image bytes into the document as markup", async () => {
      const hostile =
        '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4" onload="globalThis.__pwned=1">' +
        "<script>globalThis.__pwned=1</script>" +
        '<image href="https://example.invalid/beacon.png"/></svg>';
      const context = vaultContext({ "hostile.svg": hostile });
      const view = mountedView("text\n\n![Vector](hostile.svg)\n", 0, context);
      const host = await waitFor<HTMLElement>(view.contentDOM, ".cm-skr-image");
      // The bytes reach an image element's source and nothing else: no SVG
      // document, no script node, and no markup from the file in the tree.
      expect(host.querySelector("svg")).toBeNull();
      expect(host.querySelector("script")).toBeNull();
      expect(host.innerHTML).not.toContain("example.invalid");
      expect(host.innerHTML).not.toContain("onload");
      expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
    });

    it("types a vault file from its extension, never from its content", () => {
      expect(imageMediaType("a/b/diagram.SVG")).toBe("image/svg+xml");
      expect(imageMediaType("photo.jpeg")).toBe("image/jpeg");
      // An extension outside the allowlist names no image at all.
      expect(imageMediaType("page.html")).toBeNull();
      expect(imageMediaType("notes.md")).toBeNull();
      expect(imageMediaType("noextension")).toBeNull();
    });

    it("renders no target that would leave the product's transport", () => {
      const context = vaultContext({});
      expect(
        resolveImageSource("http://example.com/p.png", context),
      ).toBeNull();
      expect(
        resolveImageSource("javascript:alert(1)//p.png", context),
      ).toBeNull();
      expect(resolveImageSource("file:///etc/passwd.png", context)).toBeNull();
      expect(resolveImageSource("data:text/html,<b>x", context)).toBeNull();
      expect(resolveImageSource("https://example.com/p.png", context)).toEqual({
        kind: "direct",
        url: "https://example.com/p.png",
      });
    });

    it("keeps a data URL's own encoding rather than decoding it", () => {
      const url = "data:image/svg+xml,%3Csvg%20fill%3D%22%23abcdef%22%2F%3E";
      expect(resolveImageSource(url, vaultContext({}))).toEqual({
        kind: "direct",
        url,
      });
    });
  });
});

describe("footnotes", () => {
  const SOURCE = "A claim[^1] here.\n\n[^1]: The supporting note.\n";

  it("renders a reference as its raised label alone", () => {
    const view = mountedView(SOURCE, 0);
    const reference = view.contentDOM.querySelector<HTMLElement>(
      ".cm-skr-footnote-ref",
    );
    expect(reference).not.toBeNull();
    expect(reference?.textContent).toBe("1");
    expect(reference?.getAttribute("role")).toBe("doc-noteref");
    expect(reference?.getAttribute("aria-label")).toBe("Footnote 1");
    const style = getComputedStyle(reference as HTMLElement);
    expect(style.verticalAlign).toBe("super");
    // The caption step of the reading scale, resolved against the surface.
    expect(style.fontSize).toBe("12.48px");
  });

  it("renders a definition as its own line with the head reduced to the label", () => {
    const view = mountedView(SOURCE, 0);
    const line = view.contentDOM.querySelector<HTMLElement>(
      ".cm-line.cm-skr-footnote-definition",
    );
    expect(line).not.toBeNull();
    const label = line?.querySelector<HTMLElement>(
      ".cm-skr-footnote-definition-label",
    );
    expect(label?.textContent).toBe("1");
    expect(label?.getAttribute("role")).toBe("doc-backlink");
    expect(getComputedStyle(line as HTMLElement).fontSize).toBe("14px");
  });

  it("returns the reference source while the caret is inside it", () => {
    const view = mountedView(SOURCE, SOURCE.indexOf("[^1]") + 2);
    expect(view.contentDOM.querySelector(".cm-skr-footnote-ref")).toBeNull();
    expect(view.contentDOM.textContent).toContain("A claim[^1] here.");
  });

  it("travels from a reference to its definition and back", () => {
    const view = mountedView(SOURCE, 0);
    const reference = view.contentDOM.querySelector<HTMLElement>(
      ".cm-skr-footnote-ref",
    );
    reference?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    const definitionStart = SOURCE.indexOf("[^1]:");
    expect(view.state.selection.main.head).toBe(definitionStart);

    view.dispatch({ selection: { anchor: 0 } });
    const label = view.contentDOM.querySelector<HTMLElement>(
      ".cm-skr-footnote-definition-label",
    );
    label?.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, button: 0 }),
    );
    expect(view.state.selection.main.head).toBe(SOURCE.indexOf("[^1]"));
  });

  it("keeps a run of definitions written without blank lines separate", () => {
    const names = nodeNames("[^a]: First.\n[^b]: Second.\n");
    expect(names.filter((name) => name === "FootnoteDefinition")).toHaveLength(
      2,
    );
  });

  it("leaves an ordinary link reference definition alone", () => {
    expect(nodeNames("[label]: https://example.com\n")).toContain(
      "LinkReference",
    );
  });
});

describe("thematic breaks", () => {
  it.each(["---", "***", "___"])(
    "renders %s as a separator rule",
    (delimiter) => {
      const source = `before\n\n${delimiter}\n\nafter\n`;
      const view = mountedView(source, 0);
      const rule = view.contentDOM.querySelector<HTMLElement>(
        ".cm-skr-thematic-break",
      );
      expect(rule).not.toBeNull();
      expect(rule?.getAttribute("role")).toBe("separator");
      const style = getComputedStyle(rule as HTMLElement);
      expect(style.borderTopWidth).toBe("1px");
      expect(style.borderTopStyle).toBe("solid");
      expect(style.height).toBe("0px");
      // The delimiter itself is no longer painted as text.
      expect(view.contentDOM.textContent).not.toContain(delimiter);
    },
  );

  it("returns the delimiter while the caret is on its line", () => {
    const source = "before\n\n---\n\nafter\n";
    const view = mountedView(source, source.indexOf("---") + 1);
    expect(view.contentDOM.querySelector(".cm-skr-thematic-break")).toBeNull();
    expect(view.contentDOM.textContent).toContain("---");
  });

  it("reads a leading delimiter with no frontmatter as a break", () => {
    const source = "---\n\n# Heading\n\nbody\n";
    const view = mountedView(source, source.length);
    expect(
      view.contentDOM.querySelector(".cm-skr-thematic-break"),
    ).not.toBeNull();
    expect(
      view.contentDOM.querySelector(".cm-line.cm-skr-heading-1"),
    ).not.toBeNull();
    expect(nodeNames("---\n\n# Heading\n")).toContain("ATXHeading1");
  });

  it("still reads a closed leading block as frontmatter", () => {
    const names = nodeNames("---\ntitle: sample\n---\n\nbody\n");
    expect(names).toContain("Frontmatter");
    expect(names).not.toContain("HorizontalRule");
  });

  it("reads an unclosed mapping-shaped opener as a break and a paragraph", () => {
    const names = nodeNames("---\ntitle: sample\nstill open\n");
    expect(names).toContain("HorizontalRule");
    expect(names).not.toContain("Frontmatter");
  });
});

describe("quote and callout line editing", () => {
  function quoteView(doc: string, cursor: number): EditorView {
    return mountedView(doc, cursor, EMPTY_WIKILINK_CONTEXT, [quoteEditing]);
  }

  function pressEnter(view: EditorView): void {
    view.contentDOM.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  function paste(view: EditorView, text: string): void {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text },
    });
    view.contentDOM.dispatchEvent(event);
  }

  it("leaves a callout on an empty quote line", () => {
    const source = "> [!note] Title\n> body\n> \n";
    const view = quoteView(source, source.length - 1);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe("> [!note] Title\n> body\n\n");
    expect(view.state.selection.main.head).toBe(
      "> [!note] Title\n> body\n".length,
    );
  });

  it("leaves a plain blockquote on an empty quote line", () => {
    const source = "> quoted\n> \n";
    const view = quoteView(source, source.length - 1);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe("> quoted\n\n");
  });

  it("steps out of a nested quote one level at a time", () => {
    const source = "> > deep\n> > \n";
    const view = quoteView(source, source.length - 1);
    pressEnter(view);
    expect(view.state.doc.toString()).toBe("> > deep\n> \n");
    pressEnter(view);
    expect(view.state.doc.toString()).toBe("> > deep\n\n");
  });

  it("continues a quote that still has content on the line", () => {
    const source = "> quoted line\n";
    const view = quoteView(source, source.indexOf("\n"));
    pressEnter(view);
    expect(view.state.doc.toString()).toBe("> quoted line\n> \n");
  });

  it("keeps one marker when pasted content carries its own", () => {
    const source = "> [!note] Title\n> body\n> \n";
    const view = quoteView(source, source.length - 1);
    paste(view, "> [!warning] Second\n> more");
    expect(view.state.doc.toString()).toBe(
      "> [!note] Title\n> body\n> [!warning] Second\n> more\n",
    );
  });

  it("recognizes the insertions that would double a marker", () => {
    expect(doublesQuoteMarker("> ", ">")).toBe(true);
    expect(doublesQuoteMarker("> > ", "> [!tip] x")).toBe(true);
    expect(doublesQuoteMarker(">", "  > quoted")).toBe(true);
    // Content on the line means the marker the reader sees is their own.
    expect(doublesQuoteMarker("> body", "> more")).toBe(false);
    // Unquoted text carries no marker to double.
    expect(doublesQuoteMarker("> ", "plain")).toBe(false);
    expect(doublesQuoteMarker("", "> quoted")).toBe(false);
  });

  it("leaves pasted quoted content alone outside a quote", () => {
    const source = "para\n\n\n";
    const view = quoteView(source, source.length - 1);
    paste(view, "> [!tip] Pasted");
    expect(view.state.doc.toString()).toContain("> [!tip] Pasted");
    expect(view.state.doc.toString()).not.toContain("> > ");
  });
});
