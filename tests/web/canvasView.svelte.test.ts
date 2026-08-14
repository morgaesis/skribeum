import { flushSync, mount, unmount } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import CanvasView from "../../src/lib/rendering/CanvasView.svelte";
import type { CanvasDocument } from "../../src/lib/rendering/canvas";
import type { TaskStatus } from "../../src/lib/taskStatuses";

const MARKDOWN = `---
title: Hidden metadata
---
# Rendered heading

A **strong phrase** and [rendered link](https://example.com).

> [!note] Rendered callout
> Callout body

| Name | Value |
| --- | ---: |
| Ada | 10 |

\`\`\`ts
const value = 1;
\`\`\`
`;

// A leading HTML comment before the heading, matching the founder-reported
// overlap: the first content line sits immediately under the path label,
// with nothing between them but the card layout itself.
const MARKDOWN_WITH_LEADING_COMMENT =
  "<!-- #anchor -->\n# Heading\n\nBody text.\n";

function canvasWithNote(
  overrides: Partial<
    Extract<CanvasDocument["nodes"][number], { type: "file" }>
  > = {},
): CanvasDocument {
  return {
    nodes: [
      {
        id: "note",
        type: "file",
        file: "Note.md",
        x: 20,
        y: 30,
        width: 320,
        height: 180,
        ...overrides,
      },
    ],
    edges: [],
  };
}

function stubViewportRect(
  viewport: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  viewport.getBoundingClientRect = () =>
    ({
      x: rect.left,
      y: rect.top,
      top: rect.top,
      left: rect.left,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function pointerEvent(
  type: string,
  pointerId: number,
  clientX: number,
  clientY: number,
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event as PointerEvent;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("canvas viewer interactions and note rendering", () => {
  it("renders card Markdown through the read-only editor decoration pipeline", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": MARKDOWN },
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector(".cm-skr-strong")).not.toBeNull();
      expect(document.querySelector(".cm-skr-code-block")).not.toBeNull();
    });
    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    expect(card).not.toBeNull();
    expect(card?.tabIndex).toBe(0);
    expect(card?.querySelector('[contenteditable="false"]')).not.toBeNull();
    const heading = card?.querySelector(".cm-skr-heading-1");
    const headingMarker = heading?.querySelector(".cm-skr-reveal-marker");
    expect(heading?.textContent).toBe("# Rendered heading");
    expect(headingMarker?.textContent).toBe("# ");
    expect(
      headingMarker?.classList.contains("cm-skr-reveal-marker-active"),
    ).toBe(false);
    expect(card?.querySelector(".cm-skr-strong")?.textContent).toBe(
      "strong phrase",
    );
    expect(card?.querySelector(".cm-skr-link")?.textContent).toContain(
      "rendered link",
    );
    expect(card?.querySelector('[role="note"]')?.textContent).toContain(
      "Rendered callout",
    );
    expect(card?.querySelectorAll('[role="row"]')).toHaveLength(2);
    expect(card?.querySelector(".cm-skr-code-block")).not.toBeNull();
    expect(card?.textContent).not.toContain("Hidden metadata");
    expect(card?.textContent).not.toContain("**strong phrase**");

    await unmount(component);
  });

  it("uses configured task statuses in read-only cards", async () => {
    const taskStatuses: TaskStatus[] = [
      {
        symbol: "~",
        name: "Waiting for review",
        category: "ON_HOLD",
        glyph: "Ⅱ",
        color_token: "--skr-warning",
        next_status: "~",
      },
    ];
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "- [~] Review" },
        taskStatuses,
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(
        document.querySelector(
          '.cm-skr-task-checkbox[aria-label="Waiting for review"]',
        ),
      ).not.toBeNull();
    });
    await unmount(component);
  });

  it("stacks the path label above the content as non-overlapping flex siblings", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": MARKDOWN_WITH_LEADING_COMMENT },
      },
    });
    flushSync();

    await vi.waitFor(() => {
      expect(document.querySelector(".cm-skr-heading-1")).not.toBeNull();
    });
    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    const title = card?.querySelector<HTMLElement>(".skr-canvas-card-title");
    const content = card?.querySelector<HTMLElement>(".canvas-content");
    expect(card).not.toBeNull();
    expect(title).not.toBeNull();
    expect(content).not.toBeNull();
    if (card === null || card === undefined) return;
    if (title === null || title === undefined) return;
    if (content === null || content === undefined) return;

    // A column flexbox card lays its children out one after another; two
    // children can only occupy the same box if one is taken out of normal
    // flow (an absolute, fixed, or sticky position) or pulled back into its
    // sibling with a negative top margin. Both are the mechanisms the
    // reported overlap could come from, so both are asserted shut here.
    const cardStyle = getComputedStyle(card);
    expect(cardStyle.display).toBe("flex");
    expect(cardStyle.flexDirection).toBe("column");
    for (const element of [title, content]) {
      const style = getComputedStyle(element);
      expect(["static", "relative"]).toContain(style.position);
      expect(Number.parseFloat(style.marginTop || "0")).toBe(0);
    }
    // The label never grows to share space with the content, and the
    // content is the flexible remainder — the two cannot both claim the
    // same row.
    expect(getComputedStyle(title).flexGrow).toBe("0");
    expect(getComputedStyle(content).flexGrow).not.toBe("0");
    // The label precedes the content in document order, which is the order
    // a column flexbox stacks them in.
    expect(
      title.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The content area clips and fades rather than growing a scrollbar
    // past the card's bounds, per the at-rest-cards-never-scroll rule.
    expect(getComputedStyle(content).overflow).toBe("hidden");

    await unmount(component);
  });

  it("clears text selection before and after a background canvas pan", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "Selectable canvas card content" },
      },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    if (viewport === null || content === null) return;

    const range = document.createRange();
    range.selectNodeContents(content);
    const selection = window.getSelection();
    selection?.addRange(range);
    expect(selection?.rangeCount).toBe(1);

    // Dispatched on the viewport background itself (outside any card), so
    // this exercises the canvas-pan path rather than a card drag.
    const cameraBefore = viewport.dataset.camera;
    viewport.dispatchEvent(pointerEvent("pointerdown", 7, 10, 10));
    viewport.dispatchEvent(pointerEvent("pointermove", 7, 42, 54));
    viewport.dispatchEvent(pointerEvent("pointerup", 7, 42, 54));
    flushSync();

    expect(viewport.dataset.camera).not.toBe(cameraBefore);
    expect(selection?.rangeCount).toBe(0);
    expect(viewport.style.userSelect).toBe("");
    expect(viewport.classList.contains("dragging")).toBe(false);

    await unmount(component);
  });

  it("clicking empty canvas background deselects a selected card", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "content" },
      },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    expect(viewport).not.toBeNull();
    expect(card).not.toBeNull();
    if (viewport === null || card === null) return;

    card.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    card.dispatchEvent(pointerEvent("pointerup", 1, 30, 40));
    flushSync();
    expect(card.dataset.selected).toBe("true");

    viewport.dispatchEvent(pointerEvent("pointerdown", 2, 500, 500));
    viewport.dispatchEvent(pointerEvent("pointerup", 2, 500, 500));
    flushSync();
    expect(card.dataset.selected).toBe("false");

    await unmount(component);
  });

  it("routes every wheel gesture over a card to the canvas, never a card scrollbar", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "Scrollable card content" },
      },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(viewport).not.toBeNull();
    expect(content).not.toBeNull();
    if (viewport === null || content === null) return;

    const cameraBefore = viewport.dataset.camera;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: 48,
    });
    content.dispatchEvent(event);
    flushSync();

    expect(event.defaultPrevented).toBe(true);
    expect(viewport.dataset.camera).not.toBe(cameraBefore);

    await unmount(component);
  });

  it("maps a plain wheel gesture to a 1:1 pan and prevents the default scroll", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: { canvas: canvasWithNote(), previews: {} },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    expect(viewport).not.toBeNull();
    if (viewport === null) return;

    const [startPanX, startPanY] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaX: 12,
      deltaY: -30,
    });
    viewport.dispatchEvent(event);
    flushSync();

    expect(event.defaultPrevented).toBe(true);
    const [panX, panY, zoomLevel] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    expect(panX).toBeCloseTo((startPanX ?? 0) - 12, 5);
    expect(panY).toBeCloseTo((startPanY ?? 0) + 30, 5);
    expect(zoomLevel).toBe(1);

    await unmount(component);
  });

  it("zooms at the pointer position for a ctrl+wheel pinch, not the viewport origin", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: { canvas: canvasWithNote(), previews: {} },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    expect(viewport).not.toBeNull();
    if (viewport === null) return;
    stubViewportRect(viewport, { left: 100, top: 50, width: 800, height: 600 });

    const [startPanX, startPanY, startZoom] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    const anchorClientX = 300;
    const anchorClientY = 250;
    const deltaY = -10;
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY,
      ctrlKey: true,
      clientX: anchorClientX,
      clientY: anchorClientY,
    });
    viewport.dispatchEvent(event);
    flushSync();

    expect(event.defaultPrevented).toBe(true);
    const [panX, panY, zoomLevel] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    const expectedZoom = (startZoom ?? 1) * 1.02 ** -deltaY;
    const ratio = expectedZoom / (startZoom ?? 1);
    const anchorX = anchorClientX - 100;
    const anchorY = anchorClientY - 50;
    expect(zoomLevel).toBeCloseTo(expectedZoom, 6);
    expect(panX).toBeCloseTo(anchorX - (anchorX - (startPanX ?? 0)) * ratio, 5);
    expect(panY).toBeCloseTo(anchorY - (anchorY - (startPanY ?? 0)) * ratio, 5);

    await unmount(component);
  });

  it("keyboard zoom anchors at the viewport center, not a stored pointer position", async () => {
    const component = mount(CanvasView, {
      target: document.body,
      props: { canvas: canvasWithNote(), previews: {} },
    });
    flushSync();

    const viewport = document.querySelector<HTMLElement>(
      '[data-testid="canvas-view"]',
    );
    expect(viewport).not.toBeNull();
    if (viewport === null) return;
    Object.defineProperty(viewport, "clientWidth", {
      configurable: true,
      value: 400,
    });
    Object.defineProperty(viewport, "clientHeight", {
      configurable: true,
      value: 300,
    });

    const [startPanX, startPanY, startZoom] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    viewport.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "+",
        bubbles: true,
        cancelable: true,
      }),
    );
    flushSync();

    const [panX, panY, zoomLevel] = (viewport.dataset.camera ?? "")
      .split(",")
      .map(Number);
    const expectedZoom = (startZoom ?? 1) * 1.25;
    const ratio = expectedZoom / (startZoom ?? 1);
    const centerX = 200;
    const centerY = 150;
    expect(zoomLevel).toBeCloseTo(expectedZoom, 6);
    expect(panX).toBeCloseTo(centerX - (centerX - (startPanX ?? 0)) * ratio, 5);
    expect(panY).toBeCloseTo(centerY - (centerY - (startPanY ?? 0)) * ratio, 5);

    await unmount(component);
  });

  it("double-click opens the underlying note; a single click only selects", async () => {
    const opened: string[] = [];
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "content" },
        onOpenNode: (path: string) => opened.push(path),
      },
    });
    flushSync();

    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    expect(card).not.toBeNull();
    if (card === null) return;

    card.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    card.dispatchEvent(pointerEvent("pointerup", 1, 30, 40));
    flushSync();
    expect(opened).toHaveLength(0);
    expect(card.dataset.selected).toBe("true");

    // The double-click open gesture is detected from the raw pointer
    // stream: the viewport cancels pointerdown, so the browser never
    // synthesizes click or dblclick events for cards.
    card.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    card.dispatchEvent(pointerEvent("pointerup", 1, 30, 40));
    flushSync();
    expect(opened).toEqual(["Note.md"]);

    await unmount(component);
  });

  it("does not open the note when the second tap arrives after the window", async () => {
    const opened: string[] = [];
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "content" },
        onOpenNode: (path: string) => opened.push(path),
      },
    });
    flushSync();

    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    expect(card).not.toBeNull();
    if (card === null) return;

    const now = vi.spyOn(performance, "now");
    now.mockReturnValue(1000);
    card.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    card.dispatchEvent(pointerEvent("pointerup", 1, 30, 40));
    now.mockReturnValue(1600);
    card.dispatchEvent(pointerEvent("pointerdown", 1, 30, 40));
    card.dispatchEvent(pointerEvent("pointerup", 1, 30, 40));
    flushSync();
    expect(opened).toHaveLength(0);
    now.mockRestore();

    await unmount(component);
  });

  it("drags a card 1:1 with the pointer and persists only the final position", async () => {
    const moves: Array<{ id: string; x: number; y: number }> = [];
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote({ x: 100, y: 100 }),
        previews: { "Note.md": "content" },
        onMoveNode: (id: string, x: number, y: number) =>
          moves.push({ id, x, y }),
      },
    });
    flushSync();

    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    expect(card).not.toBeNull();
    if (card === null) return;

    card.dispatchEvent(pointerEvent("pointerdown", 3, 50, 50));
    card.dispatchEvent(pointerEvent("pointermove", 3, 90, 70));
    flushSync();
    // Mid-drag: the card already tracks the pointer 1:1 with no animation,
    // before the gesture ends or anything is persisted.
    expect(card.style.left).toBe("140px");
    expect(card.style.top).toBe("120px");
    expect(moves).toHaveLength(0);

    card.dispatchEvent(pointerEvent("pointerup", 3, 90, 70));
    flushSync();

    expect(moves).toEqual([{ id: "note", x: 140, y: 120 }]);

    await unmount(component);
  });

  it("requests adding and removing cards through the toolbar and per-card control", async () => {
    let added = 0;
    const removed: string[] = [];
    const component = mount(CanvasView, {
      target: document.body,
      props: {
        canvas: canvasWithNote(),
        previews: { "Note.md": "content" },
        onAddNode: () => {
          added += 1;
        },
        onRemoveNode: (id: string) => removed.push(id),
      },
    });
    flushSync();

    document.querySelector<HTMLButtonElement>(".canvas-toolbar-add")?.click();
    expect(added).toBe(1);

    document.querySelector<HTMLButtonElement>(".canvas-card-remove")?.click();
    expect(removed).toEqual(["note"]);

    await unmount(component);
  });
});
