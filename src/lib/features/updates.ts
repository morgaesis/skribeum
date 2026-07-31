// Update checking, kept behind a narrow interface so the browser demo and
// the tests can run without the Tauri updater plugin present. The plugin is
// imported lazily: a build without it (the demo) reports that updates are
// unavailable rather than failing.

import { STRINGS } from "../strings";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "failed"; message: string };

type UpdateHandle = {
  version: string;
  body?: string;
  downloadAndInstall(
    onEvent?: (event: {
      event: string;
      data?: { contentLength?: number; chunkLength?: number };
    }) => void,
  ): Promise<void>;
};

/**
 * The updater module imports cleanly outside the desktop shell; what is
 * missing there is the runtime it talks to. Detect that, so the browser
 * demo reports honestly instead of surfacing an inter-process error.
 */
function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as Record<string, unknown>)
  );
}

async function loadPlugin(): Promise<{
  check(): Promise<UpdateHandle | null>;
} | null> {
  if (!hasDesktopRuntime()) {
    return null;
  }
  try {
    return (await import("@tauri-apps/plugin-updater")) as unknown as {
      check(): Promise<UpdateHandle | null>;
    };
  } catch {
    return null;
  }
}

/**
 * Checks for an update and reports progress through `onState`. Never throws:
 * every failure path becomes a state the interface can render, because an
 * update check must not be able to break the editor.
 */
export async function checkForUpdate(
  onState: (state: UpdateState) => void,
): Promise<void> {
  onState({ kind: "checking" });
  const plugin = await loadPlugin();
  if (plugin === null) {
    onState({ kind: "unavailable", reason: STRINGS.updateUnavailable });
    return;
  }
  try {
    const update = await plugin.check();
    if (update === null) {
      onState({ kind: "current" });
      return;
    }
    onState({
      kind: "available",
      version: update.version,
      notes: update.body ?? "",
    });
  } catch (error) {
    onState({ kind: "failed", message: String(error) });
  }
}

/**
 * Downloads and installs a previously reported update, reporting progress.
 * The caller restarts the application; this function never does so on its
 * own, so an install can never interrupt unsaved work without consent.
 */
export async function installUpdate(
  onState: (state: UpdateState) => void,
): Promise<void> {
  const plugin = await loadPlugin();
  if (plugin === null) {
    onState({ kind: "unavailable", reason: STRINGS.updateUnavailable });
    return;
  }
  try {
    const update = await plugin.check();
    if (update === null) {
      onState({ kind: "current" });
      return;
    }
    let downloaded = 0;
    let total: number | null = null;
    onState({ kind: "downloading", version: update.version, percent: null });
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data?.contentLength ?? null;
      }
      if (event.event === "Progress") {
        downloaded += event.data?.chunkLength ?? 0;
        onState({
          kind: "downloading",
          version: update.version,
          percent:
            total === null || total === 0
              ? null
              : Math.min(100, Math.round((downloaded / total) * 100)),
        });
      }
    });
    onState({ kind: "ready", version: update.version });
  } catch (error) {
    onState({ kind: "failed", message: String(error) });
  }
}

/** Human-readable text for a state, so surfaces do not duplicate wording. */
export function describeUpdateState(state: UpdateState): string {
  switch (state.kind) {
    case "idle":
      return "";
    case "checking":
      return STRINGS.updateChecking;
    case "unavailable":
      return state.reason;
    case "current":
      return STRINGS.updateCurrent;
    case "available":
      return `${STRINGS.updateAvailable} ${state.version}`;
    case "downloading":
      return state.percent === null
        ? `${STRINGS.updateDownloading} ${state.version}`
        : `${STRINGS.updateDownloading} ${state.version} (${state.percent}%)`;
    case "ready":
      return `${STRINGS.updateReady} ${state.version}`;
    case "failed":
      return `${STRINGS.updateFailed}: ${state.message}`;
  }
}
