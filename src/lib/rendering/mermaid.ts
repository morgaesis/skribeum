let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

async function mermaidApi(): Promise<typeof import("mermaid").default> {
  if (mermaidPromise === null) {
    mermaidPromise = import("mermaid").then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        flowchart: { htmlLabels: false },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

function conciseError(error: unknown): string {
  const firstLine = String(error).split("\n", 1)[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : "Invalid diagram";
}

export async function renderMermaid(
  host: HTMLElement,
  source: string,
  id: string,
  errorPrefix: string,
): Promise<void> {
  try {
    const mermaid = await mermaidApi();
    await mermaid.parse(source, { suppressErrors: true });
    const result = await mermaid.render(id, source);
    if (!host.isConnected) {
      return;
    }
    host.innerHTML = result.svg;
  } catch (error) {
    if (!host.isConnected) {
      return;
    }
    host.replaceChildren();
    host.classList.add("cm-skr-render-error");
    host.removeAttribute("aria-label");
    host.setAttribute("role", "alert");
    host.textContent = `${errorPrefix}: ${conciseError(error)}`;
  }
}
