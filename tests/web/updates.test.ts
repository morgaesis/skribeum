// The update path must never break the editor: every failure mode has to
// become a renderable state rather than a thrown error. The plugin is
// absent under the test runtime, which is exactly the browser-demo case.

import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  checkForUpdateOnStartup,
  describeUpdateFailure,
  describeUpdateState,
  installUpdate,
  restartToApply,
  type UpdateState,
} from "../../src/lib/features/updates";
import { STRINGS } from "../../src/lib/strings";

async function collect(
  run: (onState: (state: UpdateState) => void) => Promise<void>,
): Promise<UpdateState[]> {
  const states: UpdateState[] = [];
  await run((state) => states.push(state));
  return states;
}

describe("update states", () => {
  it("reports checking then unavailable when the plugin is absent", async () => {
    const states = await collect((onState) => checkForUpdate(onState));
    expect(states[0]?.kind).toBe("checking");
    expect(states.at(-1)?.kind).toBe("unavailable");
  });

  it("never throws when installing without the plugin", async () => {
    const states = await collect(installUpdate);
    expect(states.at(-1)?.kind).toBe("unavailable");
  });

  // The restart path requires the desktop process plugin, absent under the
  // test runtime exactly like the updater plugin above: it must report
  // "unavailable" honestly rather than throwing or pretending to restart.
  it("never throws when restarting without the plugin", async () => {
    const states = await collect(restartToApply);
    expect(states.at(-1)?.kind).toBe("unavailable");
    // A missing restart capability must not silently claim success: the
    // interface never passes through a "restarting" or "ready" state when
    // nothing was actually attempted.
    expect(states.some((state) => state.kind === "restarting")).toBe(false);
  });

  it("describes every state without an empty message", () => {
    const samples: UpdateState[] = [
      { kind: "checking" },
      { kind: "unavailable", reason: "no plugin" },
      { kind: "current" },
      { kind: "available", version: "0.0.4", notes: "" },
      { kind: "downloading", version: "0.0.4", percent: null },
      { kind: "downloading", version: "0.0.4", percent: 42 },
      { kind: "ready", version: "0.0.4" },
      { kind: "restarting" },
      { kind: "failed", message: "network", security: false },
    ];
    for (const state of samples) {
      expect(describeUpdateState(state).length).toBeGreaterThan(0);
    }
    expect(describeUpdateState({ kind: "idle" })).toBe("");
  });

  it("includes the percentage while downloading", () => {
    expect(
      describeUpdateState({
        kind: "downloading",
        version: "1.2.3",
        percent: 42,
      }),
    ).toContain("42%");
  });

  it("reads sensibly with no known download total", () => {
    // A `null` percent means the server sent no content length; the text
    // must read as an honest "downloading, progress unknown" rather than
    // a stuck-looking "(null%)" or "(NaN%)".
    const text = describeUpdateState({
      kind: "downloading",
      version: "1.2.3",
      percent: null,
    });
    expect(text).not.toMatch(/%/);
    expect(text).not.toMatch(/null|NaN|undefined/i);
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("update failure classification", () => {
  it("flags a signature mismatch as security-relevant, not a generic glitch", () => {
    const result = describeUpdateFailure(
      new Error("failed to verify the downloaded file signature"),
    );
    expect(result.security).toBe(true);
    expect(result.message).toBe(STRINGS.updateFailedSignature);
    // The message must not read like a transient, retry-and-forget error:
    // it names the security concern explicitly.
    expect(result.message.toLowerCase()).toContain("security");
  });

  it("flags an authentication failure as security-relevant", () => {
    const result = describeUpdateFailure(
      new Error("Minisign: authentication failed"),
    );
    expect(result.security).toBe(true);
  });

  it("describes a network failure without alarming security language", () => {
    const result = describeUpdateFailure(
      new Error("error sending request: dns error: failed to lookup address"),
    );
    expect(result.security).toBe(false);
    expect(result.message).toBe(STRINGS.updateFailedNetwork);
    expect(result.message.toLowerCase()).not.toContain("security");
  });

  it("falls back to a readable generic message for an unrecognized error", () => {
    const result = describeUpdateFailure(new Error("unexpected EOF"));
    expect(result.security).toBe(false);
    expect(result.message).toContain(STRINGS.updateFailed);
    expect(result.message).toContain("unexpected EOF");
  });

  it("never renders a raw object dump for a non-Error rejection", () => {
    // A thrown value that is not an Error or a string (a Tauri IPC
    // rejection can be a plain object) must still produce readable text,
    // never the useless `[object Object]` that `String(error)` gives.
    const result = describeUpdateFailure({ code: 7 });
    expect(result.message).not.toContain("[object Object]");
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe("the startup check", () => {
  it("says nothing at all when the preference is off", async () => {
    const states = await collect((onState) =>
      checkForUpdateOnStartup({ enabled: false }, onState),
    );
    // Not even "checking": a launch that did not ask must be
    // indistinguishable from one that asked and found nothing.
    expect(states).toEqual([]);
  });

  it("says nothing without the desktop shell, whatever the preference", async () => {
    // The test runtime carries no Tauri internals, which is the browser
    // demo's situation exactly. Nothing there could install what a check
    // found, so asking would only produce a state nobody can act on.
    const states = await collect((onState) =>
      checkForUpdateOnStartup({ enabled: true }, onState),
    );
    expect(states).toEqual([]);
  });

  it("never throws", async () => {
    await expect(
      checkForUpdateOnStartup({ enabled: true }, () => {}),
    ).resolves.toBeUndefined();
  });
});
