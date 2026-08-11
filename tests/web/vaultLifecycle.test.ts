import { describe, expect, it } from "vitest";
import {
  installNativeOpenListener,
  NativeOpenQueue,
  StartupPathGate,
  VaultOwnership,
  type VaultSession,
} from "../../src/lib/vaultLifecycle";

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_error: unknown) => {};
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

describe("native open queue", () => {
  it("drains an arrival raised while listener installation is completing before recovery", async () => {
    const handled: string[] = [];
    const order: string[] = [];
    const batches = [["initial"], ["arrival"], []] as string[][];
    const queue = new NativeOpenQueue(async () => {
      while (true) {
        const paths = batches.shift() ?? [];
        if (paths.length === 0) return;
        order.push("drain");
        handled.push(...paths);
      }
    });
    const dispose = await installNativeOpenListener(async (available) => {
      order.push("listener");
      available();
      return () => {};
    }, queue);

    void queue.enqueue();
    await queue.untilQuiescent();

    expect(order[0]).toBe("listener");
    expect(handled).toEqual(["initial", "arrival"]);
    dispose();
  });
});

describe("startup path ownership", () => {
  it("opens a slow injected WebDriver path once across direct and polling startup", async () => {
    const gate = new StartupPathGate();
    const slow = deferred<void>();
    let calls = 0;
    const open = () => {
      calls += 1;
      return slow.promise;
    };

    const direct = gate.run("/e2e/vault", open);
    const polled = gate.run("/e2e/vault", open);
    expect(calls).toBe(1);
    slow.resolve();
    await Promise.all([direct, polled]);
    expect(calls).toBe(1);
  });
});

describe("vault ownership", () => {
  it("uses the canonical root for the active workspace identity", async () => {
    const ownership = new VaultOwnership<number>({
      open: async () => ({ handle: 1, root: "/vaults/canonical" }),
      close: async () => {},
    });
    let active: VaultSession<number> | null = null;

    const result = await ownership.replace(
      "/vaults/alias",
      async () => undefined,
      (session) => {
        active = session;
      },
    );

    expect(result.kind).toBe("opened");
    expect(active?.root).toBe("/vaults/canonical");
  });

  it("keeps the prior vault active and closes a replacement that fails after native open", async () => {
    const closed: number[] = [];
    let handle = 0;
    const ownership = new VaultOwnership<number>({
      open: async (path) => ({ handle: ++handle, root: path }),
      close: async (next) => {
        closed.push(next);
      },
    });
    await ownership.replace(
      "/vaults/one",
      async () => undefined,
      () => {},
    );

    const failed = await ownership.replace(
      "/vaults/two",
      async () => {
        throw new Error("index unavailable");
      },
      () => {},
    );

    expect(failed.kind).toBe("failed");
    expect(ownership.current()?.root).toBe("/vaults/one");
    expect(closed).toEqual([2]);
  });

  it("closes superseded and replaced handles, fences old generations, and closes the active handle on teardown", async () => {
    const closed: number[] = [];
    const firstPrepared = deferred<void>();
    let calls = 0;
    const ownership = new VaultOwnership<number>({
      open: async (path) => ({ handle: ++calls, root: path }),
      close: async (handle) => {
        closed.push(handle);
      },
    });
    await ownership.replace(
      "/vaults/old",
      async () => undefined,
      () => {},
    );
    const stale = ownership.replace(
      "/vaults/stale",
      async () => firstPrepared.promise,
      () => {},
    );
    const current = await ownership.replace(
      "/vaults/current",
      async () => undefined,
      () => {},
    );
    if (current.kind !== "opened")
      throw new Error("current vault did not open");
    firstPrepared.resolve();
    await stale;

    expect(ownership.isActive(current.session)).toBe(true);
    expect(closed).toEqual([2, 1]);
    await ownership.dispose();
    expect(ownership.isActive(current.session)).toBe(false);
    expect(closed).toEqual([2, 1, 3]);
  });
});
