// Wikilink resolution, previews, and activation share the navigation feature's
// address model. This editor boundary only resolves Markdown preview targets
// and translates pointer events into source document positions.

import { type Extension, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  type FollowWikilinkOptions,
  followWikilinkAt,
  resolveWikilinkTarget,
  wikilinkPositionFromElement,
} from "../../features/navigation";
import type { WikilinkResolutionContext } from "../../features/navigation";

export {
  candidateAddressForTarget,
  DEFAULT_OBSIDIAN_APP_CONFIG,
  EMPTY_WIKILINK_CONTEXT,
  type ObsidianAppConfig,
  parseObsidianAppConfig,
  resolveWikilinkTarget,
  type WikilinkResolution,
  type WikilinkResolutionContext,
} from "../../features/navigation";

/** Resolves a local Markdown-link URL to a canonical preview target. */
export function resolveMarkdownLinkTarget(
  rawTarget: string,
  context: WikilinkResolutionContext,
): string | null {
  const unwrapped =
    rawTarget.startsWith("<") && rawTarget.endsWith(">")
      ? rawTarget.slice(1, -1)
      : rawTarget;
  let decoded: string;
  try {
    decoded = decodeURIComponent(unwrapped);
  } catch {
    return null;
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(decoded) || decoded.startsWith("//")) {
    return null;
  }
  const hash = decoded.indexOf("#");
  const pathPart = hash === -1 ? decoded : decoded.slice(0, hash);
  const fragment = hash === -1 ? "" : decoded.slice(hash);
  if (pathPart.length === 0) {
    return context.currentPath === null || context.currentPath === undefined
      ? null
      : fragment;
  }
  if (pathPart.startsWith("/") || pathPart.includes("?")) {
    return null;
  }
  const base = context.currentPath?.split("/").slice(0, -1) ?? [];
  const segments = [...base];
  for (const segment of pathPart.split("/")) {
    if (segment === "." || segment.length === 0) {
      continue;
    }
    if (segment === "..") {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  const candidates = [segments.join("/"), pathPart];
  for (const candidate of candidates) {
    const resolution = resolveWikilinkTarget(candidate, context);
    if (resolution.kind === "note") {
      return `${resolution.path}${fragment}`;
    }
  }
  return null;
}

/**
 * A plain click on revealed link source remains an editor selection action.
 * Clicking rendered link text follows it before CodeMirror moves the cursor.
 * Control-click and Command-click always follow and preserve the selection.
 */
export function wikilinkPointerNavigation(
  options: () => FollowWikilinkOptions,
): Extension {
  let pendingClick: { position: number; handled: boolean } | null = null;
  return Prec.high(
    EditorView.domEventHandlers({
      mousedown(event, view) {
        pendingClick = null;
        if (event.button !== 0 || event.altKey || event.shiftKey) {
          return false;
        }
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".cm-skr-wikilink")
            : null;
        if (
          element === null ||
          !view.dom.contains(element) ||
          (!(event.ctrlKey || event.metaKey) &&
            element.classList.contains("cm-skr-reveal-source"))
        ) {
          return false;
        }
        const position = wikilinkPositionFromElement(view, element);
        if (position === null) {
          return false;
        }
        event.preventDefault();
        const handled = followWikilinkAt(view, position, options());
        pendingClick = { position, handled };
        return handled;
      },
      click(event, view) {
        if (event.button !== 0 || event.altKey || event.shiftKey) {
          pendingClick = null;
          return false;
        }
        const element =
          event.target instanceof Element
            ? event.target.closest<HTMLElement>(".cm-skr-wikilink")
            : null;
        if (element === null || !view.dom.contains(element)) {
          pendingClick = null;
          return false;
        }
        const position = wikilinkPositionFromElement(view, element);
        if (position === null) {
          pendingClick = null;
          return false;
        }
        const preceding = pendingClick;
        pendingClick = null;
        if (preceding?.position === position) {
          if (preceding.handled) {
            event.preventDefault();
          }
          return preceding.handled;
        }
        if (
          !(event.ctrlKey || event.metaKey) &&
          element.classList.contains("cm-skr-reveal-source")
        ) {
          return false;
        }
        event.preventDefault();
        return followWikilinkAt(view, position, options());
      },
    }),
  );
}
