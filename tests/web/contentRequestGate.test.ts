import { describe, expect, it } from "vitest";
import { ContentRequestGate } from "../../src/lib/features/contentRequestGate";

describe("content request generation", () => {
  it("rejects a note read that finishes after a vault switch", async () => {
    const gate = new ContentRequestGate();
    const noteRequest = gate.next();
    let finishRead: (content: string) => void = () => {};
    const read = new Promise<string>((resolve) => {
      finishRead = resolve;
    }).then((content) =>
      gate.isCurrent(noteRequest) ? content : "stale request rejected",
    );

    gate.next();
    finishRead("old folder content");

    await expect(read).resolves.toBe("stale request rejected");
  });

  it("accepts the latest note read", () => {
    const gate = new ContentRequestGate();
    expect(gate.isCurrent(gate.next())).toBe(true);
  });
});
