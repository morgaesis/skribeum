<script lang="ts">
import { STRINGS } from "./strings";

let {
  value,
  minimum,
  maximum,
  defaultValue,
  edge,
  label,
  onResize,
  onCollapse,
}: {
  value: number;
  minimum: number;
  maximum: number;
  defaultValue: number;
  edge: "left" | "right";
  label: string;
  onResize: (next: number) => void;
  onCollapse: (origin: HTMLElement) => void;
} = $props();

let dragging = $state(false);

function bounded(next: number): number {
  return Math.max(minimum, Math.min(maximum, next));
}

function beginDrag(event: PointerEvent) {
  if (event.button !== 0) return;
  event.preventDefault();
  const divider = event.currentTarget as HTMLElement;
  const pointerId = event.pointerId;
  const originX = event.clientX;
  const originValue = value;
  const rootSize = Number.parseFloat(
    getComputedStyle(document.documentElement).fontSize,
  );
  const direction = edge === "right" ? 1 : -1;
  dragging = true;
  divider.setPointerCapture(pointerId);

  const move = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return;
    onResize(
      bounded(
        originValue + (direction * (moveEvent.clientX - originX)) / rootSize,
      ),
    );
  };
  const finish = (finishEvent: PointerEvent) => {
    if (finishEvent.pointerId !== pointerId) return;
    dragging = false;
    divider.removeEventListener("pointermove", move);
    divider.removeEventListener("pointerup", finish);
    divider.removeEventListener("pointercancel", finish);
    if (divider.hasPointerCapture(pointerId)) {
      divider.releasePointerCapture(pointerId);
    }
  };
  divider.addEventListener("pointermove", move);
  divider.addEventListener("pointerup", finish);
  divider.addEventListener("pointercancel", finish);
}

// registry-exempt keydown: ARIA separator keyboard resizing is local widget
// behavior. Application-level collapse remains registered independently.
function onKeydown(event: KeyboardEvent) {
  let next: number | null = null;
  if (event.key === "ArrowLeft") next = value + (edge === "left" ? 1 : -1);
  else if (event.key === "ArrowRight")
    next = value + (edge === "left" ? -1 : 1);
  else if (event.key === "Home") next = minimum;
  else if (event.key === "End") next = maximum;
  else if (event.key === "Enter") {
    onCollapse(event.currentTarget as HTMLElement);
    event.preventDefault();
    return;
  }
  if (next === null) return;
  event.preventDefault();
  onResize(bounded(next));
}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="skr-panel-divider"
  class:skr-panel-divider-dragging={dragging}
  class:skr-panel-divider-left={edge === "left"}
  role="separator"
  aria-label={label}
  aria-orientation="vertical"
  aria-valuemin={minimum}
  aria-valuemax={maximum}
  aria-valuenow={Math.round(value * 10) / 10}
  aria-valuetext={`${Math.round(value * 10) / 10} ${STRINGS.remUnit}`}
  tabindex="0"
  onpointerdown={beginDrag}
  ondblclick={() => onResize(defaultValue)}
  onkeydown={onKeydown}
></div>
