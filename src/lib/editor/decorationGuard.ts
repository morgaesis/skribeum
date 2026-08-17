// The guards around the decoration engine: decorations never change the
// buffer, and a decoration build never takes the note's rendering with it
// when it fails. Every transaction the engine dispatches is annotated with
// `decorationOrigin`, and the dispatch wrapper asserts that no such
// transaction changes the document. Every decoration build runs through
// `guardedDecorations`, which keeps the note rendering when a build throws.

import { Annotation, type Transaction } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";

/**
 * Marks a transaction as originating from the decoration engine. Any
 * future decoration code must annotate its transactions with this, which
 * is what makes the inertness assertion enforceable rather than advisory.
 */
export const decorationOrigin = Annotation.define<boolean>();

// Asserted in dev serves and test runs, never in production builds, where
// the per-transaction check would be dead weight: a decoration that
// mutates the document is a programming error the test suites exist to
// catch before release.
const assertionsEnabled: boolean =
  import.meta.env === undefined ||
  import.meta.env.DEV === true ||
  import.meta.env.MODE === "test";

/**
 * Asserts that no decoration-originated transaction in `transactions`
 * changes the document. Called from the editor's transaction dispatcher
 * for every dispatched group.
 */
export function assertDecorationsInert(
  transactions: readonly Transaction[],
): void {
  if (!assertionsEnabled) {
    return;
  }
  for (const transaction of transactions) {
    if (
      transaction.annotation(decorationOrigin) === true &&
      transaction.docChanged
    ) {
      throw new Error("decoration-originated transaction changed the document");
    }
  }
}

/**
 * Runs a decoration build, answering `fallback` when it fails.
 *
 * CodeMirror disables a decoration provider that throws for the life of
 * the view it belongs to. Without this, one rule computing one impossible
 * range costs the note every decoration it has — the note renders as raw
 * source, and repairing the text that caused it does not bring the
 * rendering back, because the provider is gone. That is a whole note's
 * presentation resting on the arithmetic of every rule, so a build that
 * fails is contained here instead: the reader keeps the decorations the
 * note already had, and the next build that succeeds replaces them.
 *
 * The failure is reported rather than swallowed. A build that throws is a
 * defect in a rule, and the suites that drive the engine assert on it.
 */
export function guardedDecorations(
  build: () => DecorationSet,
  fallback: DecorationSet,
): DecorationSet {
  try {
    return build();
  } catch (error) {
    console.error("decoration build failed", error);
    return fallback;
  }
}
