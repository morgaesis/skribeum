// The update path must never break the editor: every failure mode has to
// become a renderable state rather than a thrown error. The plugin is
// absent under the test runtime, which is exactly the browser-demo case.

import { describe, expect, it } from "vitest";
import {
  checkForUpdate,
  describeUpdateState,
  installUpdate,
  type UpdateState,
} from "../../src/lib/features/updates";

async function collect(
  run: (onState: (state: UpdateState) => void) => Promise<void>,
): Promise<UpdateState[]> {
  const states: UpdateState[] = [];
  await run((state) => states.push(state));
  return states;
}

describe("update states", () => {
  it("reports checking then unavailable when the plugin is absent", async () => {
    const states = await collect((onState) =>
      checkForUpdate("stable", onState),
    );
    expect(states[0]?.kind).toBe("checking");
    expect(states.at(-1)?.kind).toBe("unavailable");
  });

  it("never throws when installing without the plugin", async () => {
    const states = await collect(installUpdate);
    expect(states.at(-1)?.kind).toBe("unavailable");
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
      { kind: "failed", message: "network" },
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
});
