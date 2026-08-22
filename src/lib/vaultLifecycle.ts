/**
 * Serializes native open-file drains. A listener may enqueue another drain
 * while one is in flight; recovery waits until every observed drain settles.
 */
export class NativeOpenQueue {
  private tail = Promise.resolve();

  constructor(private readonly drain: () => Promise<void>) {}

  enqueue(): Promise<void> {
    this.tail = this.tail.catch(() => {}).then(this.drain);
    return this.tail;
  }

  async untilQuiescent(): Promise<void> {
    while (true) {
      const observed = this.tail;
      await observed;
      if (observed === this.tail) return;
    }
  }
}

/**
 * How much work a requested tree refresh has to do, weakest first. A stronger
 * kind subsumes every weaker one, so a burst collapses to a single pass.
 */
export type TreeRefreshKind =
  | "tree"
  | "tags-then-tree"
  | "index"
  | "index-with-tags";

const TREE_REFRESH_RANK: Record<TreeRefreshKind, number> = {
  tree: 0,
  "tags-then-tree": 1,
  index: 2,
  "index-with-tags": 3,
};

/** Quiet period a burst of watcher events must clear before a refresh runs. */
export const TREE_REFRESH_QUIET_MILLISECONDS = 150;

/**
 * Collapses a burst of watcher events into one tree refresh, and never runs
 * two at once.
 *
 * Re-indexing walks the whole vault, so answering every raw filesystem event
 * with its own refresh makes a bulk change (a sync client landing a directory,
 * a branch checkout) cost one full walk per file. Coalescing bounds that to
 * one walk per quiet period however many events arrive.
 */
export class CoalescingTreeRefresh {
  private pending: TreeRefreshKind | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly refresh: (kind: TreeRefreshKind) => Promise<void>,
    private readonly quietMilliseconds = TREE_REFRESH_QUIET_MILLISECONDS,
  ) {}

  request(kind: TreeRefreshKind): void {
    if (
      this.pending === null ||
      TREE_REFRESH_RANK[kind] > TREE_REFRESH_RANK[this.pending]
    ) {
      this.pending = kind;
    }
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, this.quietMilliseconds);
  }

  /** Resolves once no refresh is pending or running. For tests and teardown. */
  async settled(): Promise<void> {
    while (this.pending !== null || this.running || this.timer !== null) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.quietMilliseconds),
      );
    }
  }

  private async drain(): Promise<void> {
    // A pass already running re-reads `pending` before it exits, so a request
    // that lands mid-pass is picked up rather than dropped here.
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending !== null) {
        const kind = this.pending;
        this.pending = null;
        await this.refresh(kind);
      }
    } finally {
      this.running = false;
    }
  }
}

/**
 * Makes explicit operating-system opens permanently outrank automatic session
 * recovery for one frontend lifetime. The event callback advances the epoch
 * before its queued drain begins, so an already-open recovery closes itself
 * instead of becoming active when it resolves.
 */
export class StartupRecoveryGuard {
  private nativeOpenObserved = false;
  private epoch = 0;

  observeNativeOpen(): void {
    this.nativeOpenObserved = true;
    this.epoch += 1;
  }

  beginRecovery(): number | null {
    return this.nativeOpenObserved ? null : this.epoch;
  }

  isRecoveryCurrent(epoch: number): boolean {
    return !this.nativeOpenObserved && this.epoch === epoch;
  }
}

/** Installs the native listener before any caller begins its initial drain. */
export async function installNativeOpenListener(
  listen: (available: () => void) => Promise<() => void>,
  queue: NativeOpenQueue,
  observeNativeOpen: () => void = () => {},
): Promise<() => void> {
  return await listen(() => {
    observeNativeOpen();
    void queue.enqueue();
  });
}

/** A native handle together with the root that identifies its workspace. */
export type VaultSession<Handle> = {
  handle: Handle;
  root: string;
  generation: number;
};

export type VaultOpen<Handle> = Omit<VaultSession<Handle>, "generation">;

export type VaultReplacement<Handle> =
  | { kind: "opened"; session: VaultSession<Handle> }
  | { kind: "failed"; error: unknown }
  | { kind: "superseded" };

/**
 * Owns frontend handle replacement. Preparation happens before activation so
 * a failed replacement leaves the preceding vault live. Every uncommitted or
 * displaced handle is closed through the native idempotent close contract.
 */
export class VaultOwnership<Handle> {
  private generation = 0;
  private active: VaultSession<Handle> | null = null;

  constructor(
    private readonly native: {
      open(path: string): Promise<VaultOpen<Handle>>;
      close(handle: Handle): Promise<void>;
    },
  ) {}

  current(): VaultSession<Handle> | null {
    return this.active;
  }

  isActive(session: VaultSession<Handle>): boolean {
    return (
      this.active?.generation === session.generation &&
      this.active.handle === session.handle
    );
  }

  async replace<Prepared>(
    path: string,
    prepare: (session: VaultSession<Handle>) => Promise<Prepared>,
    activate: (session: VaultSession<Handle>, prepared: Prepared) => void,
    isCurrent: () => boolean = () => true,
  ): Promise<VaultReplacement<Handle>> {
    const generation = ++this.generation;
    let opened: VaultOpen<Handle>;
    try {
      opened = await this.native.open(path);
    } catch (error) {
      return { kind: "failed", error };
    }
    const session: VaultSession<Handle> = { ...opened, generation };
    if (generation !== this.generation || !isCurrent()) {
      await this.close(session.handle);
      return { kind: "superseded" };
    }
    let prepared: Prepared;
    try {
      prepared = await prepare(session);
    } catch (error) {
      await this.close(session.handle);
      return { kind: "failed", error };
    }
    if (generation !== this.generation || !isCurrent()) {
      await this.close(session.handle);
      return { kind: "superseded" };
    }
    const prior = this.active;
    this.active = session;
    activate(session, prepared);
    if (prior !== null) await this.close(prior.handle);
    return { kind: "opened", session };
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    const active = this.active;
    this.active = null;
    if (active !== null) await this.close(active.handle);
  }

  private async close(handle: Handle): Promise<void> {
    try {
      await this.native.close(handle);
    } catch {
      // Native close is idempotent. Cleanup cannot revive a stale session.
    }
  }
}

/**
 * Coalesces a startup path while retaining support for a later injected path.
 * The path is claimed synchronously, before its asynchronous open begins.
 */
export class StartupPathGate {
  private path: string | null = null;
  private pending: Promise<unknown> | null = null;

  run(path: string, open: () => Promise<unknown>): Promise<unknown> {
    if (this.path === path && this.pending !== null) return this.pending;
    this.path = path;
    const pending = open();
    this.pending = pending;
    return pending;
  }
}
