// biome-ignore-all format: Keep the exploratory harness within its line budget.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";

export type LatencyKind = "glyph" | "surface" | "note";
export type VisualCheck = {
  id: string;
  construct: string;
  pass: boolean;
  expected: string;
  actual: string;
};

type Visibility = { selector: string; text?: string; absent?: boolean };
type Interaction = {
  intent: string;
  action: string;
  perform: () => Promise<void>;
  expectedFocus?: string[];
  visible?: Visibility;
  trigger?: { event: "beforeinput" | "click" | "keydown"; key?: string };
  latencyKind?: LatencyKind;
  scrollExpected?: boolean;
  inspect?: () => Promise<VisualCheck[]>;
  custom?: () => Promise<Record<string, boolean | number | string | null>>;
};
type Snapshot = {
  now: number;
  active: string;
  body: boolean;
  sensible: boolean;
  scroll: Record<string, number>;
  layout: number;
  layoutSupported: boolean;
  boxes: Record<string, [number, number, number, number]>;
  errors: number;
};
type UxState = {
  errors: string[];
  layout: number;
  layoutSupported: boolean;
  eventAt: number | null;
};
type UxWindow = Window & { __SKRIBEUM_UX__?: UxState };

export type TraceRecord = {
  v: 2;
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
    layoutShift: { score: number; method: "performance-observer" | "geometry" };
    consoleErrors: string[];
    visual: VisualCheck[];
    custom: Record<string, boolean | number | string | null>;
  };
  error: string | null;
};

const traces = path.join(import.meta.dirname, "traces");
const scrollSelectors = ["nav", ".cm-scroller", '[role="listbox"]', '[aria-label="Outline"]'];
const boxSelectors = ["header", "main", "nav", ".cm-editor"];
const round = (value: number, precision = 2) => {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
};

export async function installUxInstrumentation(): Promise<void> {
  await browser.execute("window.__name = window.__name || function (target) { return target; };");
  await browser.execute(() => {
    if ((window as UxWindow).__SKRIBEUM_UX__ !== undefined) return;
    const state: UxState = {
      errors: [],
      layout: 0,
      layoutSupported: false,
      eventAt: null,
    };
    (window as UxWindow).__SKRIBEUM_UX__ = state;
    const text = (value: unknown) => {
      try {
        return typeof value === "string" ? value : JSON.stringify(value);
      } catch {
        return String(value);
      }
    };
    const original = console.error;
    console.error = (...values: unknown[]) => {
      state.errors.push(values.map(text).join(" ").slice(0, 500));
      original(...values);
    };
    addEventListener("error", (event) => state.errors.push(`window error: ${event.message}`.slice(0, 500)));
    addEventListener("unhandledrejection", (event) => state.errors.push(`unhandled rejection: ${text(event.reason)}`.slice(0, 500)));
    try {
      state.layoutSupported = PerformanceObserver.supportedEntryTypes.includes("layout-shift");
      if (state.layoutSupported) {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) state.layout += (entry as PerformanceEntry & { value: number }).value;
        }).observe({ type: "layout-shift", buffered: true });
      }
    } catch {
      state.layoutSupported = false;
    }
  });
}

async function arm(trigger: NonNullable<Interaction["trigger"]>): Promise<void> {
  await browser.execute(
    (eventName, eventKey) => {
      const listener = (event: Event) => {
        if (eventKey !== undefined && (!(event instanceof KeyboardEvent) || event.key.toLowerCase() !== eventKey.toLowerCase())) return;
        const state = (window as UxWindow).__SKRIBEUM_UX__;
        if (state !== undefined) state.eventAt = performance.now();
      };
      document.addEventListener(eventName, listener, {
        capture: true,
        once: true,
      });
    },
    trigger.event,
    trigger.key,
  );
}

async function snapshot(expected: string[]): Promise<Snapshot> {
  return browser.execute(
    (focusSelectors, scrolling, rectangles): Snapshot => {
      const state = (window as UxWindow).__SKRIBEUM_UX__;
      const active = document.activeElement as HTMLElement | null;
      const body = active === null || active === document.body || active === document.documentElement;
      const descriptor = body || active === null ? "body" : `${active.tagName.toLowerCase()}:${active.getAttribute("role") ?? ""}:${active.getAttribute("aria-label") ?? ""}:${[...active.classList].slice(0, 3).join(".")}`;
      const sensible = !body && (focusSelectors.length === 0 || focusSelectors.some((selector) => active.matches(selector) || active.closest(selector) !== null));
      const scroll = Object.fromEntries(scrolling.map((selector) => [selector, document.querySelector<HTMLElement>(selector)?.scrollTop ?? 0]));
      const boxes = Object.fromEntries(
        rectangles.flatMap((selector) => {
          const element = document.querySelector(selector);
          if (element === null) return [];
          const box = element.getBoundingClientRect();
          return [[selector, [box.left, box.top, box.width, box.height]]];
        }),
      ) as Record<string, [number, number, number, number]>;
      return {
        now: performance.now(),
        active: descriptor,
        body,
        sensible,
        scroll,
        layout: state?.layout ?? 0,
        layoutSupported: state?.layoutSupported ?? false,
        boxes,
        errors: state?.errors.length ?? 0,
      };
    },
    expected,
    scrollSelectors,
    boxSelectors,
  );
}

async function waitFor(visible: Visibility): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector, expectedText, absent) => {
          const element = document.querySelector(selector);
          const found = element !== null && (expectedText === undefined || (element.textContent ?? "").includes(expectedText));
          return absent ? !found : found;
        },
        visible.selector,
        visible.text,
        visible.absent,
      ),
    {
      timeout: 30_000,
      timeoutMsg: `visibility condition failed for ${visible.selector}`,
    },
  );
}

async function settle(): Promise<void> {
  await browser.execute(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function geometry(before: Snapshot, after: Snapshot): number {
  let movement = 0;
  for (const [selector, box] of Object.entries(before.boxes)) {
    const next = after.boxes[selector];
    if (next !== undefined) movement += (Math.abs(next[0] - box[0]) + Math.abs(next[1] - box[1])) * Math.max(box[2], box[3]);
  }
  return movement / Math.max(1, 1280 * 800);
}

export class PersonaSession {
  private sequence = 0;
  private pacing: number;
  private readonly tracePath: string;

  constructor(
    readonly session: string,
    readonly persona: string,
    seed: number,
  ) {
    mkdirSync(traces, { recursive: true });
    this.tracePath = path.join(traces, `${session}.jsonl`);
    writeFileSync(this.tracePath, "");
    this.pacing = seed >>> 0;
  }

  async interact(interaction: Interaction): Promise<TraceRecord> {
    const expected = interaction.expectedFocus ?? [];
    const before = await snapshot(expected);
    if (interaction.trigger !== undefined) await arm(interaction.trigger);
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    try {
      await interaction.perform();
      if (interaction.visible !== undefined) await waitFor(interaction.visible);
      await settle();
    } catch (cause) {
      status = "error";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const after = await snapshot(expected);
    const state = await browser.execute(() => (window as UxWindow).__SKRIBEUM_UX__ ?? null);
    const deltaByContainer = Object.fromEntries(Object.entries(after.scroll).map(([selector, value]) => [selector, round(value - (before.scroll[selector] ?? 0))]));
    const unexpectedPx = interaction.scrollExpected ? 0 : Object.values(deltaByContainer).reduce((sum, value) => sum + Math.abs(value), 0);
    let visual: VisualCheck[] = [];
    try {
      visual = (await interaction.inspect?.()) ?? [];
    } catch (cause) {
      visual = [
        {
          id: "inspection-error",
          construct: interaction.action,
          pass: false,
          expected: "visual inspection completes",
          actual: cause instanceof Error ? cause.message : String(cause),
        },
      ];
    }
    const measured = state?.eventAt ?? null;
    const record: TraceRecord = {
      v: 2,
      session: this.session,
      persona: this.persona,
      seq: ++this.sequence,
      intent: interaction.intent,
      action: interaction.action,
      status,
      signal: {
        latency:
          interaction.latencyKind === undefined
            ? null
            : {
                kind: interaction.latencyKind,
                ms: round(measured === null ? after.now - before.now : after.now - measured),
                source: measured === null ? "webdriver-fallback" : "event-to-paint",
              },
        focus: {
          before: before.active,
          after: after.active,
          sensible: after.sensible,
          body: after.body,
        },
        scroll: { unexpectedPx: round(unexpectedPx), deltaByContainer },
        layoutShift: {
          score: round(after.layoutSupported ? after.layout - before.layout : geometry(before, after), 4),
          method: after.layoutSupported ? "performance-observer" : "geometry",
        },
        consoleErrors: state?.errors.slice(before.errors) ?? [],
        visual,
        custom: (await interaction.custom?.()) ?? {},
      },
      error,
    };
    appendFileSync(this.tracePath, `${JSON.stringify(record)}\n`);
    this.pacing = (Math.imul(this.pacing, 1_664_525) + 1_013_904_223) >>> 0;
    await browser.pause(20 + (this.pacing % 41));
    return record;
  }
}
