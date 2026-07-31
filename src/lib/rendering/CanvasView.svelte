<script lang="ts">
import { STRINGS } from "../strings";
import { type CanvasDocument, type CanvasNode, edgePoint } from "./canvas";

let {
  canvas,
  previews = {},
}: {
  canvas: CanvasDocument;
  previews?: Readonly<Record<string, string>>;
} = $props();

let viewport: HTMLElement;
let panX = $state(24);
let panY = $state(24);
let zoom = $state(1);
let drag = $state<{ pointer: number; x: number; y: number } | null>(null);

const nodesById = $derived(
  new Map(canvas.nodes.map((node) => [node.id, node])),
);

function setZoom(next: number) {
  zoom = Math.min(3, Math.max(0.25, next));
}

function resetCamera() {
  panX = 24;
  panY = 24;
  zoom = 1;
}

// registry-exempt keydown: camera controls internal to this registered
// content view. Arrow keys pan, plus/minus zoom, and zero resets.
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
      setZoom(zoom * 1.2);
      break;
    case "-":
      setZoom(zoom / 1.2);
      break;
    case "0":
      resetCamera();
      break;
    default:
      return;
  }
  event.preventDefault();
}

function onWheel(event: WheelEvent) {
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    setZoom(zoom * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
  } else {
    panX -= event.deltaX;
    panY -= event.deltaY;
  }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  viewport.setPointerCapture(event.pointerId);
}

function onPointerMove(event: PointerEvent) {
  if (drag === null || drag.pointer !== event.pointerId) return;
  panX += event.clientX - drag.x;
  panY += event.clientY - drag.y;
  drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
}

function onPointerUp(event: PointerEvent) {
  if (drag?.pointer === event.pointerId) drag = null;
}

function cameraInteractions(node: HTMLElement) {
  node.addEventListener("keydown", onKeydown);
  node.addEventListener("wheel", onWheel, { passive: false });
  node.addEventListener("pointerdown", onPointerDown);
  node.addEventListener("pointermove", onPointerMove);
  node.addEventListener("pointerup", onPointerUp);
  node.addEventListener("pointercancel", onPointerUp);
  return {
    destroy() {
      node.removeEventListener("keydown", onKeydown);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointercancel", onPointerUp);
    },
  };
}

function nodeLabel(node: CanvasNode): string {
  return node.type === "text"
    ? STRINGS.canvasTextNodeLabel
    : `${STRINGS.canvasFileNodeLabel}: ${node.file}`;
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
  class:dragging={drag !== null}
  role="region"
  aria-label={STRINGS.canvasViewerLabel}
  aria-describedby="canvas-keyboard-help"
  tabindex="0"
  data-testid="canvas-view"
  data-camera={`${panX},${panY},${zoom}`}
>
  <p id="canvas-keyboard-help" class="sr-only">{STRINGS.canvasKeyboardHelp}</p>
  <div class="canvas-toolbar" aria-label={STRINGS.canvasControlsLabel}>
    <button type="button" aria-label={STRINGS.canvasZoomOut} onclick={() => setZoom(zoom / 1.2)}>−</button>
    <output aria-label={STRINGS.canvasZoomLevel}>{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label={STRINGS.canvasZoomIn} onclick={() => setZoom(zoom * 1.2)}>+</button>
    <button type="button" onclick={resetCamera}>{STRINGS.canvasResetView}</button>
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
          {@const from = edgePoint(fromNode, edge.fromSide)}
          {@const to = edgePoint(toNode, edge.toSide)}
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
      <article
        class="canvas-card"
        data-node-id={node.id}
        aria-label={nodeLabel(node)}
        style={`left:${node.x}px;top:${node.y}px;width:${node.width}px;height:${node.height}px;--canvas-node-color:${node.color ?? "var(--skr-border)"}`}
      >
        {#if node.type === "text"}
          <div class="canvas-content">{node.text}</div>
        {:else}
          <div class="skr-canvas-card-title">{node.file}</div>
          <pre class="canvas-content">{previews[node.file] ?? STRINGS.canvasFileUnavailable}</pre>
        {/if}
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
    border-radius: 0.55rem;
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow);
  }
  .canvas-toolbar button {
    min-width: 2rem;
    min-height: 2rem;
    border: 1px solid var(--skr-border);
    border-radius: 0.35rem;
    background: var(--skr-surface);
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
    box-sizing: border-box;
    overflow: auto;
    border: 2px solid var(--canvas-node-color);
    border-radius: 0.6rem;
    background: var(--skr-surface-raised);
    box-shadow: var(--skr-shadow);
  }
  .canvas-card .skr-canvas-card-title {
    position: sticky;
    top: 0;
    overflow: hidden;
    padding: 0.45rem 0.65rem;
    border-bottom: 1px solid var(--skr-border);
    color: var(--skr-text-muted);
    background: var(--skr-surface-subtle);
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .canvas-content {
    margin: 0;
    padding: 0.7rem;
    color: var(--skr-text);
    font: inherit;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
