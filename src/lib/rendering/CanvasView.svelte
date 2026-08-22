<script lang="ts">
import type { WikilinkResolutionContext } from "../editor/decorations/wikilinks";
import { STRINGS } from "../strings";
import { DEFAULT_TASK_STATUSES, type TaskStatus } from "../taskStatuses";
import { type CanvasDocument, type CanvasNode, edgePoint } from "./canvas";
import ReadOnlyNote from "./ReadOnlyNote.svelte";

let {
  canvas,
  previews = {},
  linkContext = null,
  taskStatuses = DEFAULT_TASK_STATUSES,
  onOpenNode,
  onMoveNode,
  onRemoveNode,
  onAddNode,
}: {
  canvas: CanvasDocument;
  previews?: Readonly<Record<string, string>>;
  linkContext?: WikilinkResolutionContext | null;
  taskStatuses?: readonly TaskStatus[];
  /** Opens the given note path in the editor, leaving the canvas view. */
  onOpenNode?: (path: string) => void;
  /** Persists a card's new world-space position after a drag ends. */
  onMoveNode?: (nodeId: string, x: number, y: number) => void;
  /** Removes a card from the board. Never deletes the underlying note. */
  onRemoveNode?: (nodeId: string) => void;
  /** Requests adding an existing note to the board as a new card. */
  onAddNode?: () => void;
} = $props();

// A screen-space pointer movement smaller than this, in CSS pixels, is
// still a click: pointing devices jitter a few pixels between press and
// release even when the user's intent is a plain click, and treating that
// jitter as a drag would make single-click selection unreliable.
const DRAG_THRESHOLD = 3;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;

let viewport: HTMLElement;
let panX = $state(24);
let panY = $state(24);
let zoom = $state(1);
let drag = $state<{
  pointer: number;
  x: number;
  y: number;
  moved: boolean;
} | null>(null);
let cardDrag = $state<{
  pointer: number;
  nodeId: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  currentX: number;
  currentY: number;
  moved: boolean;
} | null>(null);
let selectedNodeId = $state<string | null>(null);
let lastCardTap: { nodeId: string; time: number } | null = null;
let previousUserSelect = "";

/**
 * The viewport cancels pointerdown to own panning and dragging, which also
 * suppresses the browser's synthesized click and dblclick events, so the
 * double-click open gesture is detected from the pointer stream itself.
 */
const DOUBLE_TAP_WINDOW_MS = 400;

const nodesById = $derived(
  new Map(canvas.nodes.map((node) => [node.id, node])),
);

/** A node's geometry, substituting the live in-progress drag position. */
function liveNode(node: CanvasNode): CanvasNode {
  if (cardDrag !== null && cardDrag.nodeId === node.id) {
    return { ...node, x: cardDrag.currentX, y: cardDrag.currentY };
  }
  return node;
}

function clampZoom(next: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
}

/**
 * Zooms to `nextZoom`, keeping the world point currently under
 * `(anchorX, anchorY)` (viewport-relative CSS pixels) fixed on screen.
 * Geometry that follows a pointer or an explicit anchor never animates
 * (the instant-tracking rule this view applies to pan, zoom, and drag
 * alike), so this reassigns state directly rather than transitioning it.
 */
function zoomAt(nextZoom: number, anchorX: number, anchorY: number) {
  const clamped = clampZoom(nextZoom);
  const ratio = clamped / zoom;
  panX = anchorX - (anchorX - panX) * ratio;
  panY = anchorY - (anchorY - panY) * ratio;
  zoom = clamped;
}

/** Keyboard and toolbar zoom anchor at the viewport center, never a point. */
function zoomAtCenter(nextZoom: number) {
  const width = viewport?.clientWidth ?? 0;
  const height = viewport?.clientHeight ?? 0;
  zoomAt(nextZoom, width / 2, height / 2);
}

function resetCamera() {
  panX = 24;
  panY = 24;
  zoom = 1;
}

function focusedCardId(): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  return active.closest<HTMLElement>(".canvas-card")?.dataset.nodeId ?? null;
}

function openNode(node: CanvasNode) {
  if (node.type === "file") {
    onOpenNode?.(node.file);
  }
}

// registry-exempt keydown: camera controls internal to this registered
// content view. Arrow keys pan, plus/minus zoom at the viewport center,
// zero resets, and Enter opens the focused card (the keyboard equivalent
// of the double-click open gesture).
function onKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case "ArrowLeft":
      panX += 40;
      break;
    case "ArrowRight":
      panX -= 40;
      break;
    case "ArrowUp":
      panY += 40;
      break;
    case "ArrowDown":
      panY -= 40;
      break;
    case "+":
    case "=":
      zoomAtCenter(zoom * 1.25);
      break;
    case "-":
      zoomAtCenter(zoom / 1.25);
      break;
    case "0":
      resetCamera();
      break;
    case "Enter": {
      const nodeId = focusedCardId();
      const node = nodeId !== null ? nodesById.get(nodeId) : undefined;
      if (node === undefined) return;
      openNode(node);
      break;
    }
    default:
      return;
  }
  event.preventDefault();
}

/**
 * Every wheel gesture over the canvas is captured, so a trackpad's
 * two-finger scroll never leaks past this view to scroll the surrounding
 * page. Plain wheel motion pans; the pinch gesture browsers deliver as a
 * `ctrlKey` wheel event zooms at the pointer, matching the pinch constant
 * a real continuous gesture needs rather than a mouse notch's coarser
 * step.
 */
function onWheel(event: WheelEvent) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    const rect = viewport.getBoundingClientRect();
    zoomAt(
      zoom * 1.02 ** -event.deltaY,
      event.clientX - rect.left,
      event.clientY - rect.top,
    );
    return;
  }
  const linePixels = 16;
  const pagePixels = viewport.clientHeight || 800;
  const multiplier =
    event.deltaMode === WheelEvent.DOM_DELTA_LINE
      ? linePixels
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
        ? pagePixels
        : 1;
  panX -= event.deltaX * multiplier;
  panY -= event.deltaY * multiplier;
}

function clearSelection() {
  window.getSelection()?.removeAllRanges();
}

function suppressSelection() {
  previousUserSelect = viewport.style.userSelect;
  viewport.style.userSelect = "none";
  clearSelection();
}

function restoreSelection() {
  viewport.style.userSelect = previousUserSelect;
  clearSelection();
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  if (
    event.target instanceof Element &&
    event.target.closest("button, a, input, select, textarea") !== null
  ) {
    return;
  }
  const cardElement =
    event.target instanceof Element
      ? event.target.closest<HTMLElement>(".canvas-card")
      : null;
  const cardNodeId = cardElement?.dataset.nodeId;
  const node = cardNodeId !== undefined ? nodesById.get(cardNodeId) : undefined;
  event.preventDefault();
  suppressSelection();
  viewport.setPointerCapture?.(event.pointerId);
  if (node !== undefined) {
    cardDrag = {
      pointer: event.pointerId,
      nodeId: node.id,
      startX: event.clientX,
      startY: event.clientY,
      originX: node.x,
      originY: node.y,
      currentX: node.x,
      currentY: node.y,
      moved: false,
    };
    return;
  }
  drag = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: false,
  };
}

function exceedsDragThreshold(dx: number, dy: number): boolean {
  return Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD;
}

function onPointerMove(event: PointerEvent) {
  if (cardDrag !== null && cardDrag.pointer === event.pointerId) {
    event.preventDefault();
    const screenDx = event.clientX - cardDrag.startX;
    const screenDy = event.clientY - cardDrag.startY;
    cardDrag = {
      ...cardDrag,
      currentX: cardDrag.originX + screenDx / zoom,
      currentY: cardDrag.originY + screenDy / zoom,
      moved: cardDrag.moved || exceedsDragThreshold(screenDx, screenDy),
    };
    return;
  }
  if (drag === null || drag.pointer !== event.pointerId) return;
  event.preventDefault();
  const dx = event.clientX - drag.x;
  const dy = event.clientY - drag.y;
  panX += dx;
  panY += dy;
  drag = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    moved: drag.moved || exceedsDragThreshold(dx, dy),
  };
}

function endCardDrag(pointerId: number) {
  if (cardDrag === null || cardDrag.pointer !== pointerId) return;
  const { nodeId, moved, currentX, currentY } = cardDrag;
  cardDrag = null;
  if (moved) {
    lastCardTap = null;
    onMoveNode?.(nodeId, currentX, currentY);
    return;
  }
  selectedNodeId = nodeId;
  const now = performance.now();
  if (
    lastCardTap !== null &&
    lastCardTap.nodeId === nodeId &&
    now - lastCardTap.time <= DOUBLE_TAP_WINDOW_MS
  ) {
    lastCardTap = null;
    const node = nodesById.get(nodeId);
    if (node !== undefined) openNode(node);
    return;
  }
  lastCardTap = { nodeId, time: now };
}

function onPointerUp(event: PointerEvent) {
  if (viewport.hasPointerCapture?.(event.pointerId)) {
    viewport.releasePointerCapture(event.pointerId);
  }
  if (cardDrag?.pointer === event.pointerId) {
    endCardDrag(event.pointerId);
    restoreSelection();
    return;
  }
  if (drag?.pointer !== event.pointerId) return;
  const wasClick = !drag.moved;
  drag = null;
  if (wasClick) {
    selectedNodeId = null;
  }
  restoreSelection();
}

function cameraInteractions(node: HTMLElement) {
  node.addEventListener("keydown", onKeydown);
  node.addEventListener("wheel", onWheel, { passive: false });
  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerUp);
  node.addEventListener("lostpointercapture", onPointerUp);
  return {
    destroy() {
      if (drag !== null || cardDrag !== null) {
        drag = null;
        cardDrag = null;
        restoreSelection();
      }
      node.removeEventListener("keydown", onKeydown);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerUp);
      node.removeEventListener("lostpointercapture", onPointerUp);
    },
  };
}

function nodeLabel(node: CanvasNode): string {
  return node.type === "text"
    ? STRINGS.canvasTextNodeLabel
    : `${STRINGS.canvasFileNodeLabel}: ${node.file}`;
}

function contextFor(node: CanvasNode): WikilinkResolutionContext | undefined {
  if (linkContext === null) return undefined;
  const currentPath =
    node.type === "file" ? node.file : (linkContext.currentPath ?? null);
  return {
    ...linkContext,
    currentPath,
    embedDepth: 0,
    embedAncestry: currentPath === null ? [] : [currentPath],
  };
}

export function focus() {
  viewport?.focus();
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  bind:this={viewport}
  use:cameraInteractions
  class="canvas-viewport"
  class:dragging={drag !== null || cardDrag !== null}
  role="region"
  aria-label={STRINGS.canvasViewerLabel}
  aria-describedby="canvas-keyboard-help"
  tabindex="0"
  data-testid="canvas-view"
  data-camera={`${panX},${panY},${zoom}`}
>
  <p id="canvas-keyboard-help" class="sr-only">{STRINGS.canvasKeyboardHelp}</p>
  <div class="canvas-toolbar" aria-label={STRINGS.canvasControlsLabel}>
    <button type="button" aria-label={STRINGS.canvasZoomOut} onclick={() => zoomAtCenter(zoom / 1.25)}>−</button>
    <output aria-label={STRINGS.canvasZoomLevel}>{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label={STRINGS.canvasZoomIn} onclick={() => zoomAtCenter(zoom * 1.25)}>+</button>
    <button type="button" class="skr-btn-secondary" data-btn-role="secondary" onclick={resetCamera}>{STRINGS.canvasResetView}</button>
    {#if onAddNode !== undefined}
      <button type="button" class="canvas-toolbar-add" aria-label={STRINGS.canvasAddCard} onclick={() => onAddNode?.()}>
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
          <path d="M8 6v4m-2-2h4" />
        </svg>
      </button>
    {/if}
  </div>
  <div
    class="canvas-world"
    data-testid="canvas-world"
    style={`transform: translate(${panX}px, ${panY}px) scale(${zoom})`}
  >
    <svg class="canvas-edges" aria-hidden="true">
      {#each canvas.edges as edge (edge.id)}
        {@const fromNode = nodesById.get(edge.fromNode)}
        {@const toNode = nodesById.get(edge.toNode)}
        {#if fromNode !== undefined && toNode !== undefined}
          {@const from = edgePoint(liveNode(fromNode), edge.fromSide)}
          {@const to = edgePoint(liveNode(toNode), edge.toSide)}
          <line
            data-edge-id={edge.id}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            style:stroke={edge.color}
          />
        {/if}
      {/each}
    </svg>
    {#each canvas.nodes as node (node.id)}
      {@const geometry = liveNode(node)}
      <article
        class="canvas-card"
        class:selected={selectedNodeId === node.id}
        class:card-dragging={cardDrag !== null && cardDrag.nodeId === node.id && cardDrag.moved}
        data-node-id={node.id}
        aria-label={nodeLabel(node)}
        data-selected={selectedNodeId === node.id}
        tabindex="0"
        style={`left:${geometry.x}px;top:${geometry.y}px;width:${geometry.width}px;height:${geometry.height}px;--canvas-node-color:${node.color ?? "var(--skr-border)"}`}
      >
        {#if node.type === "file"}
          <div class="skr-canvas-card-title">{node.file}</div>
        {/if}
        {#if onRemoveNode !== undefined}
          <button
            type="button"
            class="canvas-card-remove"
            aria-label={STRINGS.canvasRemoveCard}
            onclick={(event) => {
              event.stopPropagation();
              onRemoveNode?.(node.id);
            }}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4.5 4.5 7 7m0-7-7 7" />
            </svg>
          </button>
        {/if}
        <div class="canvas-content">
          {#if node.type === "text"}
            <ReadOnlyNote
              source={node.text}
              label={nodeLabel(node)}
              context={contextFor(node)}
              {taskStatuses}
            />
          {:else}
            <ReadOnlyNote
              source={previews[node.file] ?? STRINGS.canvasFileUnavailable}
              label={nodeLabel(node)}
              context={contextFor(node)}
              {taskStatuses}
            />
          {/if}
        </div>
      </article>
    {/each}
  </div>
</div>

<style>
  .canvas-viewport {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    touch-action: none;
    cursor: grab;
    color: var(--skr-text);
    background-color: var(--skr-canvas);
    background-image: radial-gradient(var(--skr-border) 0.7px, transparent 0.7px);
    background-size: 18px 18px;
  }
  .canvas-viewport.dragging { cursor: grabbing; }
  .canvas-viewport.dragging { user-select: none; }
  .canvas-toolbar {
    position: absolute;
    z-index: 3;
    right: 0.75rem;
    bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    padding: 0.25rem;
    border: 1px solid var(--skr-border);
    border-radius: var(--skr-radius-surface);
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow-surface);
  }
  .canvas-toolbar button {
    min-width: 2rem;
    min-height: 2rem;
    border: 0;
    border-radius: var(--skr-radius-control);
    background: transparent;
    color: var(--skr-text);
  }

  .canvas-toolbar button:hover {
    background: var(--skr-surface-subtle);
  }

  .canvas-toolbar .skr-btn-secondary {
    min-width: auto;
    padding-inline: 0.625rem;
  }

  .canvas-toolbar-add {
    display: grid;
    place-items: center;
  }

  .canvas-toolbar-add svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 1.25;
  }

  @media (max-width: 60rem) {
    .canvas-toolbar button {
      min-width: 2.75rem;
      min-height: 2.75rem;
    }
  }
  .canvas-toolbar output {
    min-width: 3.5rem;
    text-align: center;
    color: var(--skr-text-muted);
    font-variant-numeric: tabular-nums;
  }
  .canvas-world {
    position: absolute;
    inset: 0;
    transform-origin: 0 0;
  }
  .canvas-edges {
    position: absolute;
    inset: 0;
    width: 10000px;
    height: 10000px;
    overflow: visible;
    pointer-events: none;
  }
  .canvas-edges line {
    stroke: var(--skr-text-muted);
    stroke-width: 2;
  }
  .canvas-card {
    position: absolute;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
    overflow: hidden;
    border: 2px solid var(--canvas-node-color);
    border-radius: var(--skr-radius-surface);
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow-surface);
    cursor: pointer;
  }
  .canvas-card.card-dragging {
    cursor: grabbing;
  }
  .canvas-card.selected {
    box-shadow: 0 0 0 2px var(--skr-focus);
  }
  .canvas-card:focus-visible {
    outline: 2px solid var(--skr-focus);
    outline-offset: 2px;
  }
  .canvas-card .skr-canvas-card-title {
    flex: 0 0 auto;
    overflow: hidden;
    padding: 0.45rem 0.65rem;
    border-bottom: 1px solid var(--skr-border);
    color: var(--skr-text-muted);
    background: var(--skr-surface-subtle);
    font-size: var(--skr-type-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .canvas-content {
    flex: 1 1 auto;
    min-height: 0;
    margin: 0;
    padding: 0.7rem;
    color: var(--skr-text);
    overflow: hidden;
    overflow-wrap: anywhere;
    /* Cards are a fixed-size preview, not a scroll surface at rest: per the
       pan-versus-scroll rule, a two-finger gesture over a resting card
       always pans the board. Content past the card's bounds clips and
       fades rather than growing a scrollbar. */
    mask-image: linear-gradient(to bottom, black calc(100% - 1.5rem), transparent 100%);
    -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 1.5rem), transparent 100%);
  }
  .canvas-card-remove {
    position: absolute;
    top: 0.375rem;
    right: 0.375rem;
    z-index: 1;
    display: grid;
    width: 1.5rem;
    height: 1.5rem;
    place-items: center;
    border: 0;
    border-radius: var(--skr-radius-control);
    padding: 0;
    color: var(--skr-text-muted);
    background: var(--skr-surface-raised);
    opacity: 0;
  }
  .canvas-card-remove svg {
    width: 1rem;
    height: 1rem;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 1.25;
  }
  .canvas-card-remove:hover {
    background: var(--skr-surface-subtle);
    color: var(--skr-text);
  }
  .canvas-card:hover .canvas-card-remove,
  .canvas-card:focus-within .canvas-card-remove {
    opacity: 1;
  }
  @media (pointer: coarse) {
    .canvas-card-remove {
      opacity: 1;
    }
  }
</style>
