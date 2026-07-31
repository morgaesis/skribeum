// The scratch vault the end-to-end suite edits. The WebdriverIO config
// recreates it before the app launches and exports its location through
// SKRIBEUM_E2E_VAULT; the webdriver-feature build announces that path to
// the webview, which opens the vault on startup (the directory-picker
// dialog cannot be driven headlessly). Specs assert against the files on
// disk directly.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SCRATCH_VAULT_PATH = path.join(os.tmpdir(), "skribeum-e2e-vault");

export const LF_NOTE_NAME = "note.md";
export const LF_NOTE_CONTENT = "alpha\nbeta\ngamma\n";

export const CRLF_NOTE_NAME = "crlf.md";
export const CRLF_NOTE_CONTENT = "first\r\nsecond\r\nthird\r\n";

// Named to sort after the other notes so the keyboard-traversal spec's
// arrow-key expectations over the first two rows stay stable.
export const LIVE_PREVIEW_NOTE_NAME = "z-live-preview.md";
export const LIVE_PREVIEW_NOTE_CONTENT =
  "# Sunrise heading\n\nbody text here\n";

/**
 * Resets the scratch vault to its fixture files. The vault root itself is
 * never deleted: the WebdriverIO launcher starts the app before the worker
 * process re-evaluates this module, and removing a directory an inotify
 * watcher is subscribed to silently kills the subscription for the rest of
 * the session. Contents are reset entry by entry instead.
 */
export function createScratchVault(): void {
  mkdirSync(SCRATCH_VAULT_PATH, { recursive: true });
  for (const entry of readdirSync(SCRATCH_VAULT_PATH)) {
    rmSync(path.join(SCRATCH_VAULT_PATH, entry), {
      recursive: true,
      force: true,
    });
  }
  writeFileSync(path.join(SCRATCH_VAULT_PATH, LF_NOTE_NAME), LF_NOTE_CONTENT);
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, CRLF_NOTE_NAME),
    CRLF_NOTE_CONTENT,
  );
  writeFileSync(
    path.join(SCRATCH_VAULT_PATH, LIVE_PREVIEW_NOTE_NAME),
    LIVE_PREVIEW_NOTE_CONTENT,
  );
}
