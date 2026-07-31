import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";

export type LatencyKind = "glyph" | "surface" | "note";
type Value = boolean | number | string | null;
type Trigger = {
  event: "beforeinput" | "click" | "keydown";
  key: string | null;
};
type Visible = { selector: string; text: string | null; absent?: boolean };
type PageState = {
  errors: string[];
  layoutScore: number;
  layoutSupported: boolean;
  request: {
    trigger: Trigger;
    visible: Pick<Visible, "selector" | "text">;
    start: number | null;
    result: number | null;
    pending: boolean;
  } | null;
};
type PageWindow = Window & { __SKRIBEUM_UX__?: PageState };
type Snapshot = {
  now: number;
  active: string;
  body: boolean;
  sensible: boolean;
  scroll: Record<string, number>;
  layoutScore: number;
  layoutSupported: boolean;
  consoleCount: number;
};

export type TraceRecord = {
  v: 1;
  session: string;
  persona: string;
  seq: number;
  intent: string;
  action: string;
  status: "ok" | "error";
  signal: {
    latency: {
      kind: LatencyKind;
      ms: number;
      source: "event-to-paint" | "webdriver-fallback";
    } | null;
    focus: { before: string; after: string; sensible: boolean; body: boolean };
    scroll: { unexpectedPx: number; deltaByContainer: Record<string, number> };
    layoutShift: {
      score: number;
      method: "performance-observer" | "unsupported";
    };
    consoleErrors: string[];
    custom: Record<string, Value>;
  };
  error: string | null;
};

type Interaction = {
  intent: string;
  action: string;
  perform: () => Promise<void>;
  expectedFocus?: string[];
  visible?: Visible;
  trigger?: Trigger;
  latencyKind?: LatencyKind;
  scrollExpected?: boolean;
  custom?: () => Promise<Record<string, Value>>;
};

const traceDirectory = path.join(import.meta.dirname, "traces");
const scrollSelectors = [
  "nav",
  ".cm-scroller",
  '[role="listbox"]',
  '[role="tree"][aria-label="Outline"]',
];
const round = (value: number, precision = 2) => {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
};

export async function installUxInstrumentation(): Promise<void> {
  await browser.execute(() => {
    const page = window as PageWindow;
    if (page.__SKRIBEUM_UX__ !== undefined) return;
    const state: PageState = {
      errors: [],
      layoutScore: 0,
      layoutSupported: false,
      request: null,
    };
    page.__SKRIBEUM_UX__ = state;
    const stringify = (value: unknown) => {
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (typeof value === "string") return value;
      try {
        return JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const originalError = console.error;
    console.error = (...values: unknown[]) => {
      state.errors.push(values.map(stringify).join(" ").slice(0, 500));
      originalError(...values);
    };
    addEventListener("error", (event) =>
      state.errors.push(`window error: ${event.message}`.slice(0, 500)),
    );
    addEventListener("unhandledrejection", (event) =>
      state.errors.push(
        `unhandled rejection: ${stringify(event.reason)}`.slice(0, 500),
      ),
    );
    const visible = () => {
      const request = state.request;
      if (request?.start === null || request?.pending || request === null)
        return;
      const target = document.querySelector(request.visible.selector);
      if (
        target === null ||
        (request.visible.text !== null &&
          !(target.textContent ?? "").includes(request.visible.text))
      )
        return;
      request.pending = true;
      requestAnimationFrame(() => {
        request.result = performance.now() - (request.start ?? 0);
      });
    };
    const triggered = (event: Event) => {
      const request = state.request;
      if (
        request === null ||
        event.type !== request.trigger.event ||
        (request.trigger.key !== null &&
          (!(event instanceof KeyboardEvent) ||
            event.key !== request.trigger.key))
      )
        return;
      request.start = performance.now();
      visible();
    };
    for (const type of ["beforeinput", "click", "keydown"])
      document.addEventListener(type, triggered, true);
    new MutationObserver(visible).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    try {
      state.layoutSupported =
        PerformanceObserver.supportedEntryTypes.includes("layout-shift");
      if (state.layoutSupported)
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            state.layoutScore += (
              entry as PerformanceEntry & { value: number }
            ).value;
        }).observe({ type: "layout-shift", buffered: true });
    } catch {
      state.layoutSupported = false;
    }
  });
}

async function snapshot(expected: string[]): Promise<Snapshot> {
  return browser.execute(
    (focusSelectors: string[], scrolling: string[]) => {
      const state = (window as PageWindow).__SKRIBEUM_UX__;
      const active = document.activeElement as HTMLElement | null;
      const body =
        active === null ||
        active === document.body ||
        active === document.documentElement;
      const descriptor = body
        ? "body"
        : `${active?.tagName.toLowerCase()}:${active?.getAttribute("role") ?? ""}:${active?.dataset.testid ?? ""}:${active?.getAttribute("aria-label") ?? ""}:${[...(active?.classList ?? [])].slice(0, 3).join(".")}`;
      const sensible =
        !body &&
        (focusSelectors.length === 0 ||
          focusSelectors.some(
            (selector) =>
              active?.matches(selector) === true ||
              active?.closest(selector) !== null,
          ));
      return {
        now: performance.now(),
        active: descriptor,
        body,
        sensible,
        scroll: Object.fromEntries(
          scrolling.map((selector) => [
            selector,
            document.querySelector<HTMLElement>(selector)?.scrollTop ?? 0,
          ]),
        ),
        layoutScore: state?.layoutScore ?? 0,
        layoutSupported: state?.layoutSupported ?? false,
        consoleCount: state?.errors.length ?? 0,
      };
    },
    expected,
    scrollSelectors,
  );
}

async function waitFor(visible: Visible): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute((target: Visible) => {
        const element = document.querySelector(target.selector);
        const found =
          element !== null &&
          (target.text === null ||
            (element.textContent ?? "").includes(target.text));
        return target.absent === true ? !found : found;
      }, visible),
    {
      timeout: 30_000,
      timeoutMsg: `visibility failed for ${visible.selector}`,
    },
  );
}

export class PersonaSession {
  private sequence = 0;
  private pacing: number;
  private readonly tracePath: string;

  constructor(
    private readonly session: string,
    private readonly persona: string,
    seed: number,
  ) {
    mkdirSync(traceDirectory, { recursive: true });
    this.tracePath = path.join(traceDirectory, `${session}.jsonl`);
    writeFileSync(this.tracePath, "");
    this.pacing = seed >>> 0;
  }

  async interact(value: Interaction): Promise<TraceRecord> {
    const expected = value.expectedFocus ?? [];
    const before = await snapshot(expected);
    if (value.latencyKind && value.trigger && value.visible?.absent !== true)
      await browser.execute(
        (trigger: Trigger, visible: Pick<Visible, "selector" | "text">) => {
          const state = (window as PageWindow).__SKRIBEUM_UX__;
          if (state)
            state.request = {
              trigger,
              visible,
              start: null,
              result: null,
              pending: false,
            };
        },
        value.trigger,
        value.visible ?? { selector: "body", text: null },
      );
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    try {
      await value.perform();
      if (value.visible) await waitFor(value.visible);
      await browser.execute(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve()),
          ),
      );
    } catch (cause) {
      status = "error";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const after = await snapshot(expected);
    const page = await browser.execute((from: number) => {
      const state = (window as PageWindow).__SKRIBEUM_UX__;
      return {
        measured: state?.request?.result ?? null,
        errors: state?.errors.slice(from) ?? [],
      };
    }, before.consoleCount);
    const deltas = Object.fromEntries(
      Object.entries(after.scroll).map(([selector, scrollTop]) => [
        selector,
        round(scrollTop - (before.scroll[selector] ?? 0)),
      ]),
    );
    const record: TraceRecord = {
      v: 1,
      session: this.session,
      persona: this.persona,
      seq: ++this.sequence,
      intent: value.intent,
      action: value.action,
      status,
      signal: {
        latency: value.latencyKind
          ? {
              kind: value.latencyKind,
              ms: round(page.measured ?? after.now - before.now),
              source: page.measured ? "event-to-paint" : "webdriver-fallback",
            }
          : null,
        focus: {
          before: before.active,
          after: after.active,
          sensible: after.sensible,
          body: after.body,
        },
        scroll: {
          unexpectedPx: value.scrollExpected
            ? 0
            : round(
                Object.values(deltas).reduce(
                  (sum, delta) => sum + Math.abs(delta),
                  0,
                ),
              ),
          deltaByContainer: deltas,
        },
        layoutShift: {
          score: round(after.layoutScore - before.layoutScore, 4),
          method: after.layoutSupported
            ? "performance-observer"
            : "unsupported",
        },
        consoleErrors: page.errors,
        custom: (await value.custom?.()) ?? {},
      },
      error,
    };
    appendFileSync(this.tracePath, `${JSON.stringify(record)}\n`);
    this.pacing = (Math.imul(this.pacing, 1_664_525) + 1_013_904_223) >>> 0;
    await browser.pause(20 + (this.pacing % 41));
    return record;
  }
}
