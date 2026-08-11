export type PostPaintClock = {
  requestFrame: (callback: FrameRequestCallback) => number;
  cancelFrame: (handle: number) => void;
  scheduleTask: (callback: () => void) => ReturnType<typeof setTimeout>;
  cancelTask: (handle: ReturnType<typeof setTimeout>) => void;
};

const browserClock: PostPaintClock = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  scheduleTask: (callback) => setTimeout(callback, 0),
  cancelTask: (handle) => clearTimeout(handle),
};

/** Coalesces replaceable work into one task after the next browser paint. */
export class PostPaintScheduler {
  private generation = 0;
  private frame: number | undefined;
  private taskHandle: ReturnType<typeof setTimeout> | undefined;
  private pending: (() => void) | undefined;
  private cycle: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(private readonly clock: PostPaintClock = browserClock) {}

  schedule(task: () => void): void {
    this.pending = task;
    if (this.frame !== undefined || this.taskHandle !== undefined) return;
    if (this.cycle === undefined) {
      let resolve = () => {};
      const promise = new Promise<void>((settled) => {
        resolve = settled;
      });
      this.cycle = { promise, resolve };
    }
    const generation = this.generation;
    this.frame = this.clock.requestFrame(() => {
      this.frame = undefined;
      if (generation !== this.generation) return;
      this.taskHandle = this.clock.scheduleTask(() => {
        this.taskHandle = undefined;
        if (generation !== this.generation) return;
        const pending = this.pending;
        this.pending = undefined;
        try {
          pending?.();
        } finally {
          this.finishCycleIfIdle();
        }
      });
    });
  }

  /** Resolves after the queued task runs or a lifecycle fence invalidates it. */
  settled(): Promise<void> {
    return this.cycle?.promise ?? Promise.resolve();
  }

  /** Invalidates queued work at note-identity and component-lifetime fences. */
  fence(): void {
    this.generation += 1;
    this.pending = undefined;
    if (this.frame !== undefined) {
      this.clock.cancelFrame(this.frame);
      this.frame = undefined;
    }
    if (this.taskHandle !== undefined) {
      this.clock.cancelTask(this.taskHandle);
      this.taskHandle = undefined;
    }
    this.finishCycleIfIdle();
  }

  private finishCycleIfIdle(): void {
    if (
      this.frame !== undefined ||
      this.taskHandle !== undefined ||
      this.pending !== undefined
    ) {
      return;
    }
    const cycle = this.cycle;
    this.cycle = undefined;
    cycle?.resolve();
  }
}
