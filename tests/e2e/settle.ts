// Waiting for a surface to come to rest, for fixtures that would otherwise
// describe one mid-flight.
//
// Nearly every assertion in this suite reads the rendered result of an action
// the application answers asynchronously: a navigation, a decoration rebuild,
// a measure pass, a focus move. Reading once, immediately, asks whether the
// answer has arrived rather than what the answer is, so the fixture passes on
// a machine quick enough to have finished and fails on a loaded one that has
// not. The failure then surfaces as whatever the surface happened to be
// holding, which is rarely recognisable as a timing problem: an empty custom
// property, an undefined dataset entry, focus on `body`, or the source text a
// decoration was about to replace.
//
// These helpers exist so that a fixture states the property it means rather
// than the moment it sampled.

import { browser } from "@wdio/globals";

/** Resolves after two animation frames, or promptly if none are scheduled. */
async function afterPaint(): Promise<void> {
  await browser.executeAsync<true, []>((done) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => done(true));
    });
  });
}

/**
 * Reads a value repeatedly until two consecutive reads agree, and reports the
 * value they agreed on.
 *
 * An action can reach the rendered result through more than one scheduled
 * pass, so waiting a fixed number of frames is not evidence that the last of
 * them has run. Two matching reads are that evidence. A surface that never
 * comes to rest still reports its final reading, so the caller's assertion
 * describes what it settled on rather than the call hanging.
 */
export async function settled<T>(read: () => Promise<T>): Promise<T> {
  let previous = await read();
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await afterPaint();
    const current = await read();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

/**
 * Waits until the window is showing the browser-demo document identified by
 * `run`.
 *
 * Every demo document carries the same shell, the same editor, and the same
 * resolved tokens, so the readiness checks a fixture makes after navigating
 * are all satisfied by the document the previous test left behind: a
 * navigation that has not landed is indistinguishable from one that has. The
 * per-navigation counter in the query string is the only thing that tells
 * them apart, so wait for it before asking the document anything else.
 */
export async function waitForDemoDocument(run: string): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser.execute(() =>
        new URLSearchParams(location.search).get("test-run"),
      )) === run,
    {
      timeout: 15000,
      timeoutMsg: `the browser demo never navigated to test run ${run}`,
    },
  );
}
