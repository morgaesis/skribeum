// Buffer immutability under decoration, the M1b "decorations are inert"
// criterion. The decoration engine itself lands at M2, but the enforcement
// mechanism lands now: every transaction the engine will ever dispatch
// must be annotated with `decorationOrigin`, and the dispatch wrapper
// asserts that no such transaction changes the document. The corpus test
// scaffold in `tests/web/` drives this guard at sampled cursor positions
// over every corpus file and grows with the engine at M2.

import { Annotation, type Transaction } from "@codemirror/state";

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
