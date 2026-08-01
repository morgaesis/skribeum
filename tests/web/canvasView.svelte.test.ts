import { flushSync, mount, unmount } from "svelte";
import { describe, expect, it, vi } from "vitest";
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

function canvasWithNote(): CanvasDocument {
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
      },
    ],
    edges: [],
  };
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

  it("clears text selection before and after a canvas pan", async () => {
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

    const cameraBefore = viewport.dataset.camera;
    content.dispatchEvent(pointerEvent("pointerdown", 7, 10, 10));
    viewport.dispatchEvent(pointerEvent("pointermove", 7, 42, 54));
    viewport.dispatchEvent(pointerEvent("pointerup", 7, 42, 54));
    flushSync();

    expect(viewport.dataset.camera).not.toBe(cameraBefore);
    expect(selection?.rangeCount).toBe(0);
    expect(viewport.style.userSelect).toBe("");
    expect(viewport.classList.contains("dragging")).toBe(false);

    await unmount(component);
  });

  it("scrolls an overflowing card before routing wheel movement to the canvas", async () => {
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
    const card = document.querySelector<HTMLElement>('[data-node-id="note"]');
    const content = document.querySelector<HTMLElement>(".cm-content");
    expect(viewport).not.toBeNull();
    expect(card).not.toBeNull();
    expect(content).not.toBeNull();
    if (viewport === null || card === null || content === null) return;

    Object.defineProperties(card, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 300 },
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 320 },
    });
    const cameraBefore = viewport.dataset.camera;
    content.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 48,
      }),
    );
    flushSync();

    expect(card.scrollTop).toBe(48);
    expect(viewport.dataset.camera).toBe(cameraBefore);

    card.scrollTop = 200;
    content.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 48,
      }),
    );
    flushSync();
    expect(card.scrollTop).toBe(200);
    expect(viewport.dataset.camera).not.toBe(cameraBefore);

    await unmount(component);
  });
});
