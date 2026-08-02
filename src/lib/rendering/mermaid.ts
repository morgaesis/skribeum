let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

type RenderedDiagram = {
  host: HTMLElement;
  source: string;
  id: string;
  errorPrefix: string;
  accessibleLabel: string | null;
  generation: number;
};

const renderedDiagrams = new Map<HTMLElement, RenderedDiagram>();
let renderQueue: Promise<void> = Promise.resolve();
let themeObserver: MutationObserver | null = null;
let cleanupObserver: MutationObserver | null = null;
let colorSchemeQuery: MediaQueryList | null = null;
let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
let themeRenderQueued = false;

async function mermaidApi(): Promise<typeof import("mermaid").default> {
  if (mermaidPromise === null) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => mermaid);
  }
  return mermaidPromise;
}

function token(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim();
}

function themeVariables(root = document.documentElement) {
  const styles = getComputedStyle(root);
  const surface = token(styles, "--skr-surface");
  const surfaceSubtle = token(styles, "--skr-surface-subtle");
  const text = token(styles, "--skr-text");
  return {
    background: surface,
    edgeLabelBackground: surface,
    primaryColor: surfaceSubtle,
    mainBkg: surfaceSubtle,
    primaryTextColor: text,
    textColor: text,
    primaryBorderColor: token(styles, "--skr-border-strong"),
    lineColor: token(styles, "--skr-text-muted"),
    secondaryColor: token(styles, "--skr-accent-subtle"),
    tertiaryColor: token(styles, "--skr-canvas"),
    clusterBkg: token(styles, "--skr-canvas"),
    clusterBorder: token(styles, "--skr-border"),
    noteBkgColor: token(styles, "--skr-warning-surface"),
    noteTextColor: text,
    noteBorderColor: token(styles, "--skr-warning"),
    fontFamily: token(styles, "--skr-font-interface"),
    fontSize: "14px",
  };
}

function initializeMermaid(mermaid: typeof import("mermaid").default) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    suppressErrorRendering: true,
    theme: "base",
    themeVariables: themeVariables(),
    flowchart: { htmlLabels: false },
  });
}

function conciseError(error: unknown): string {
  const firstLine = String(error).split("\n", 1)[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : "Invalid diagram";
}

async function renderDiagram(
  diagram: RenderedDiagram,
  generation: number,
): Promise<void> {
  if (!diagram.host.isConnected) {
    renderedDiagrams.delete(diagram.host);
    cleanupDisconnectedDiagrams();
    return;
  }
  try {
    const mermaid = await mermaidApi();
    initializeMermaid(mermaid);
    await mermaid.parse(diagram.source, { suppressErrors: true });
    const result = await mermaid.render(
      `${diagram.id}-theme-${generation}`,
      diagram.source,
    );
    if (!diagram.host.isConnected || diagram.generation !== generation) return;
    diagram.host.classList.remove("cm-skr-render-error");
    diagram.host.setAttribute("role", "img");
    if (diagram.accessibleLabel !== null) {
      diagram.host.setAttribute("aria-label", diagram.accessibleLabel);
    }
    diagram.host.innerHTML = result.svg;
    diagram.host.dataset.mermaidThemeGeneration = String(generation);
  } catch (error) {
    if (!diagram.host.isConnected || diagram.generation !== generation) return;
    diagram.host.replaceChildren();
    diagram.host.classList.add("cm-skr-render-error");
    diagram.host.removeAttribute("aria-label");
    diagram.host.setAttribute("role", "alert");
    diagram.host.textContent = `${diagram.errorPrefix}: ${conciseError(error)}`;
  }
}

function queueRender(diagram: RenderedDiagram): Promise<void> {
  const generation = ++diagram.generation;
  const queued = renderQueue
    .catch(() => {})
    .then(() => renderDiagram(diagram, generation));
  renderQueue = queued.catch(() => {});
  return queued;
}

function rerenderConnectedDiagrams() {
  for (const [host, diagram] of renderedDiagrams) {
    if (!host.isConnected) {
      renderedDiagrams.delete(host);
      continue;
    }
    void queueRender(diagram);
  }
  cleanupDisconnectedDiagrams();
}

function cleanupDisconnectedDiagrams() {
  for (const host of renderedDiagrams.keys()) {
    if (!host.isConnected) renderedDiagrams.delete(host);
  }
  if (renderedDiagrams.size > 0) return;
  cleanupObserver?.disconnect();
  cleanupObserver = null;
  themeObserver?.disconnect();
  themeObserver = null;
  colorSchemeQuery?.removeEventListener("change", invalidateTheme);
  colorSchemeQuery = null;
}

function scheduleDisconnectedCleanup() {
  if (cleanupTimer !== null) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = null;
    cleanupDisconnectedDiagrams();
  }, 250);
}

function invalidateTheme() {
  if (themeRenderQueued) return;
  themeRenderQueued = true;
  queueMicrotask(() => {
    themeRenderQueued = false;
    rerenderConnectedDiagrams();
  });
}

function observeTheme() {
  if (themeObserver !== null) return;
  themeObserver = new MutationObserver(invalidateTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-light-palette", "data-dark-palette"],
  });
  colorSchemeQuery =
    window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
  colorSchemeQuery?.addEventListener("change", invalidateTheme);
  cleanupObserver = new MutationObserver(scheduleDisconnectedCleanup);
  cleanupObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
}

export async function renderMermaid(
  host: HTMLElement,
  source: string,
  id: string,
  errorPrefix: string,
): Promise<void> {
  scheduleDisconnectedCleanup();
  observeTheme();
  const previousDiagram = renderedDiagrams.get(host);
  if (previousDiagram !== undefined) previousDiagram.generation += 1;
  const diagram: RenderedDiagram = {
    host,
    source,
    id,
    errorPrefix,
    accessibleLabel: host.getAttribute("aria-label"),
    generation: 0,
  };
  renderedDiagrams.set(host, diagram);
  await queueRender(diagram);
}
