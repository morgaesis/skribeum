import { STRINGS } from "./strings";

export const ASYNC_SKELETON_DELAY_MS = 150;
export const EMBED_TIMEOUT_MS = 8_000;
export const PREVIEW_TIMEOUT_MS = 4_000;

export type AsyncContentKind = "embed" | "preview";

type AsyncContentOptions<T> = {
  host: HTMLElement;
  kind: AsyncContentKind;
  load: () => Promise<T>;
  render: (value: T) => void;
  unavailable: (value: T) => boolean;
  onRetry?: () => void;
  skeletonDelayMs?: number;
};

const WIDTHS: Record<AsyncContentKind, readonly string[]> = {
  embed: ["100", "62"],
  preview: ["100", "88", "54"],
};

/** Builds the shared asynchronous-content skeleton without moving geometry. */
export function renderAsyncSkeleton(
  host: HTMLElement,
  kind: AsyncContentKind,
): void {
  host.dataset.loadingState = "skeleton";
  host.setAttribute("role", "status");
  host.setAttribute("aria-label", STRINGS.loadingContent);
  host.replaceChildren(
    ...WIDTHS[kind].map((width) => {
      const bar = host.ownerDocument.createElement("span");
      bar.className = "skr-skeleton-bar";
      bar.style.width = `${width}%`;
      bar.setAttribute("aria-hidden", "true");
      return bar;
    }),
  );
}

/** Replaces pending content with the shared in-place failure treatment. */
export function renderAsyncFailure(
  host: HTMLElement,
  kind: AsyncContentKind,
  onRetry?: () => void,
): void {
  if (kind === "embed") {
    host.closest(".cm-skr-embed")?.classList.add("cm-skr-embed-failed");
  }
  host.dataset.loadingState = "failure";
  host.setAttribute("role", "status");
  host.removeAttribute("aria-label");
  const message = host.ownerDocument.createElement("span");
  message.className = "skr-loading-failure-message";
  message.textContent = STRINGS.couldNotLoad;
  host.replaceChildren(message);
  if (kind === "embed" && onRetry !== undefined) {
    const retry = host.ownerDocument.createElement("button");
    retry.type = "button";
    retry.className = "skr-loading-retry";
    retry.textContent = STRINGS.retryAction;
    retry.addEventListener("click", onRetry, { once: true });
    host.append(retry);
  }
}

/**
 * Runs one asynchronous content request with the product grace, skeleton,
 * timeout, and failure rules. The returned cleanup makes late results inert.
 */
export function runAsyncContent<T>(
  options: AsyncContentOptions<T>,
): () => void {
  const { host, kind } = options;
  let active = true;
  if (kind === "embed") {
    host.closest(".cm-skr-embed")?.classList.remove("cm-skr-embed-failed");
  }
  host.dataset.loadingState = "pending";
  host.replaceChildren();
  host.setAttribute("aria-label", STRINGS.loadingContent);

  const skeletonDelay = options.skeletonDelayMs ?? ASYNC_SKELETON_DELAY_MS;
  let skeletonTimer: ReturnType<typeof setTimeout> | null = null;
  if (skeletonDelay <= 0) {
    renderAsyncSkeleton(host, kind);
  } else {
    skeletonTimer = setTimeout(() => {
      if (active) renderAsyncSkeleton(host, kind);
    }, skeletonDelay);
  }
  const timeoutTimer = setTimeout(
    () => {
      if (!active) return;
      active = false;
      if (skeletonTimer !== null) clearTimeout(skeletonTimer);
      renderAsyncFailure(host, kind, options.onRetry);
    },
    kind === "embed" ? EMBED_TIMEOUT_MS : PREVIEW_TIMEOUT_MS,
  );
  let geometryFrame: number | null = null;
  let previousMinHeight: string | null = null;
  const restoreGeometry = () => {
    if (previousMinHeight === null) return;
    host.style.minHeight = previousMinHeight;
    previousMinHeight = null;
  };
  const reserveGeometryThroughRender = () => {
    const height = host.getBoundingClientRect().height;
    if (!(height > 0)) return;
    previousMinHeight = host.style.minHeight;
    host.style.minHeight = `${height}px`;
    geometryFrame = requestAnimationFrame(() => {
      geometryFrame = null;
      restoreGeometry();
    });
  };

  void options.load().then(
    (value) => {
      if (!active) return;
      active = false;
      if (skeletonTimer !== null) clearTimeout(skeletonTimer);
      clearTimeout(timeoutTimer);
      if (options.unavailable(value)) {
        renderAsyncFailure(host, kind, options.onRetry);
        return;
      }
      reserveGeometryThroughRender();
      host.dataset.loadingState = "content";
      host.removeAttribute("role");
      host.removeAttribute("aria-label");
      host.replaceChildren();
      options.render(value);
    },
    () => {
      if (!active) return;
      active = false;
      if (skeletonTimer !== null) clearTimeout(skeletonTimer);
      clearTimeout(timeoutTimer);
      renderAsyncFailure(host, kind, options.onRetry);
    },
  );

  return () => {
    active = false;
    if (skeletonTimer !== null) clearTimeout(skeletonTimer);
    clearTimeout(timeoutTimer);
    if (geometryFrame !== null) cancelAnimationFrame(geometryFrame);
    restoreGeometry();
  };
}
