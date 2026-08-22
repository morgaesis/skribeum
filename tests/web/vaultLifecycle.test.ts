import { describe, expect, it } from "vitest";
import {
  CoalescingTreeRefresh,
  installNativeOpenListener,
  NativeOpenQueue,
  StartupPathGate,
  StartupRecoveryGuard,
  type TreeRefreshKind,
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

describe("startup recovery priority", () => {
  it("keeps an OS target authoritative before, during, and after recovery completes", async () => {
    for (const timing of ["before", "during", "after"] as const) {
      const closed: number[] = [];
      const recoveryOpened = deferred<{ handle: number; root: string }>();
      const priority = new StartupRecoveryGuard();
      const ownership = new VaultOwnership<number>({
        open: async (path) => {
          if (path === "/session") return recoveryOpened.promise;
          return { handle: 2, root: "/os" };
        },
        close: async (handle) => {
          closed.push(handle);
        },
      });
      const token = priority.beginRecovery();

      if (timing === "before") priority.observeNativeOpen();
      const recovery =
        token === null || !priority.isRecoveryCurrent(token)
          ? Promise.resolve({ kind: "superseded" as const })
          : ownership.replace(
              "/session",
              async () => undefined,
              () => {},
              () => priority.isRecoveryCurrent(token),
            );

      if (timing === "during") priority.observeNativeOpen();
      if (timing !== "before")
        recoveryOpened.resolve({ handle: 1, root: "/session" });

      if (timing === "after") {
        await recovery;
        priority.observeNativeOpen();
      }

      const os = await ownership.replace(
        "/os",
        async () => undefined,
        () => {},
      );
      await recovery;

      expect(os.kind, timing).toBe("opened");
      expect(ownership.current()?.root, timing).toBe("/os");
      if (timing === "before") expect(closed, timing).not.toContain(1);
      else expect(closed, timing).toContain(1);
    }
  });

  it("marks native intent synchronously before its queued drain runs", async () => {
    const priority = new StartupRecoveryGuard();
    const blocked = deferred<void>();
    const queue = new NativeOpenQueue(async () => blocked.promise);
    let available: (() => void) | undefined;
    await installNativeOpenListener(
      async (callback) => {
        available = callback;
        return () => {};
      },
      queue,
      () => priority.observeNativeOpen(),
    );

    available?.();

    expect(priority.beginRecovery()).toBeNull();
    blocked.resolve();
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

describe("coalescing tree refresh", () => {
  it("collapses an event burst into a single strongest refresh", async () => {
    const ran: TreeRefreshKind[] = [];
    const refresh = new CoalescingTreeRefresh(async (kind) => {
      ran.push(kind);
    }, 5);

    for (let index = 0; index < 500; index += 1) refresh.request("tree");
    refresh.request("index-with-tags");
    for (let index = 0; index < 500; index += 1) refresh.request("tree");
    await refresh.settled();

    expect(ran).toEqual(["index-with-tags"]);
  });

  it("never runs two refreshes concurrently and picks up a mid-pass request", async () => {
    const ran: TreeRefreshKind[] = [];
    let active = 0;
    let peak = 0;
    const firstRunning = deferred<void>();
    const releaseFirst = deferred<void>();

    const refresh = new CoalescingTreeRefresh(async (kind) => {
      active += 1;
      peak = Math.max(peak, active);
      ran.push(kind);
      if (ran.length === 1) {
        firstRunning.resolve();
        await releaseFirst.promise;
      }
      active -= 1;
    }, 1);

    refresh.request("tree");
    await firstRunning.promise;
    // Lands while the first pass is still in flight.
    refresh.request("index");
    releaseFirst.resolve();
    await refresh.settled();

    expect(peak).toBe(1);
    expect(ran).toEqual(["tree", "index"]);
  });
});
