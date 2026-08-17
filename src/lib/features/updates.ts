// Update checking, kept behind a narrow interface so the browser demo and
// the tests can run without the Tauri updater plugin present. The plugin is
// imported lazily: a build without it (the demo) reports that updates are
// unavailable rather than failing.

import { invoke } from "@tauri-apps/api/core";
import { updateCheck } from "../ipc/services";
import { STRINGS } from "../strings";

export type UpdateState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "unavailable"; reason: string }
  | { kind: "current" }
  | { kind: "available"; version: string; notes: string }
  | { kind: "downloading"; version: string; percent: number | null }
  | { kind: "ready"; version: string }
  | { kind: "restarting" }
  | { kind: "failed"; message: string; security: boolean };

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
export function hasDesktopRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in (window as unknown as Record<string, unknown>)
  );
}

/** Pulls a readable message out of whatever an IPC rejection throws. */
function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const text = JSON.stringify(error);
    if (text !== undefined && text !== "{}") return text;
  } catch {
    // Falls through to the generic stringification below.
  }
  return String(error);
}

/**
 * Turns a thrown error into a message a person can act on and a flag for
 * whether it is security-relevant. A signature or authentication failure
 * means the download did not match what the update server signed for, so it
 * is reported distinctly from an ordinary network hiccup rather than folded
 * into the same "something went wrong, try again" text.
 */
export function describeUpdateFailure(error: unknown): {
  message: string;
  security: boolean;
} {
  const raw = errorText(error);
  const lower = raw.toLowerCase();
  if (/signature|minisign|authenticat|tamper/.test(lower)) {
    return { message: STRINGS.updateFailedSignature, security: true };
  }
  if (
    /network|dns|timeout|timed out|connect|reqwest|offline|unreachable/.test(
      lower,
    )
  ) {
    return { message: STRINGS.updateFailedNetwork, security: false };
  }
  return { message: `${STRINGS.updateFailed}: ${raw}`, security: false };
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
  channel: "stable" | "beta",
  onState: (state: UpdateState) => void,
): Promise<void> {
  onState({ kind: "checking" });
  if (!hasDesktopRuntime()) {
    onState({ kind: "unavailable", reason: STRINGS.updateUnavailable });
    return;
  }
  try {
    const result = await updateCheck(channel);
    if (result.kind === "current") {
      onState({ kind: "current" });
      return;
    }
    onState({
      kind: "available",
      version: result.version,
      notes: result.notes,
    });
  } catch (error) {
    onState({ kind: "failed", ...describeUpdateFailure(error) });
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
    onState({ kind: "failed", ...describeUpdateFailure(error) });
  }
}

/**
 * Restarts the application to finish installing a previously downloaded
 * update. Never called on its own: the caller confirms with the person and
 * flushes unsaved work first, the same way any other path that closes the
 * window does, so an install can never interrupt work in progress. When the
 * restart itself succeeds the process exits and there is nothing left to
 * report; a rejection (the platform declining to relaunch) becomes a
 * `failed` state instead of a silent no-op.
 */
export async function restartToApply(
  onState: (state: UpdateState) => void,
): Promise<void> {
  if (!hasDesktopRuntime()) {
    onState({ kind: "unavailable", reason: STRINGS.updateUnavailable });
    return;
  }
  onState({ kind: "restarting" });
  try {
    await invoke("plugin:process|restart");
  } catch (error) {
    onState({ kind: "failed", ...describeUpdateFailure(error) });
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
    case "restarting":
      return STRINGS.updateRestarting;
    case "failed":
      return state.message;
  }
}
