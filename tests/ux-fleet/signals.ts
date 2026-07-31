import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { browser } from "@wdio/globals";

export type LatencyKind = "glyph" | "surface" | "note";

type MeasurementTrigger = {
  event: "beforeinput" | "click" | "keydown";
  key: string | null;
};

type Visibility = {
  selector: string;
  text: string | null;
  absent?: boolean;
};

type Snapshot = {
  now: number;
  active: string;
  bodyFocus: boolean;
  focusSensible: boolean;
  scroll: Record<string, number>;
  layoutScore: number;
  layoutSupported: boolean;
  rectangles: Record<string, [number, number, number, number]>;
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
    focus: {
      before: string;
      after: string;
      sensible: boolean;
      body: boolean;
    };
    scroll: {
      unexpectedPx: number;
      deltaByContainer: Record<string, number>;
    };
    layoutShift: {
      score: number;
      method: "performance-observer" | "geometry";
    };
    consoleErrors: string[];
    custom: Record<string, boolean | number | string | null>;
  };
  error: string | null;
};

type Interaction = {
  intent: string;
  action: string;
  perform: () => Promise<void>;
  expectedFocus?: string[];
  visible?: Visibility;
  trigger?: MeasurementTrigger;
  latencyKind?: LatencyKind;
  scrollExpected?: boolean;
  custom?: () => Promise<Record<string, boolean | number | string | null>>;
};

type UxState = {
  errors: string[];
  layoutScore: number;
  layoutSupported: boolean;
  measurement?: { result: number | null; cleanup: () => void };
};

type UxWindow = Window & { __SKRIBEUM_UX__?: UxState };

const tracesDirectory = path.join(import.meta.dirname, "traces");
const scrollSelectors = [
  "nav",
  ".cm-scroller",
  '[role="listbox"]',
  '[role="tree"][aria-label="Outline"]',
];
const rectangleSelectors = ["header", "main", "nav", "section", ".cm-editor"];

function round(value: number, precision = 2): number {
  const scale = 10 ** precision;
  return Math.round(value * scale) / scale;
}

/**
 * The bundler wraps nested functions in its keep-names helper, `__name`,
 * which does not exist in the page: any transpiled function serialized into
 * `browser.execute` throws on its first nested declaration. This shim is
 * itself a string, so it reaches the page untranspiled, and every later
 * measurement runs unchanged. It must run before any other injected code
 * and again after each navigation.
 */
async function installKeepNamesShim(): Promise<void> {
  await browser.execute(
    "window.__name = window.__name || function (target) { return target; };",
  );
}

export async function installUxInstrumentation(): Promise<void> {
  await installKeepNamesShim();
  await browser.execute(() => {
    const uxWindow = window as UxWindow;
    if (uxWindow.__SKRIBEUM_UX__ !== undefined) {
      return;
    }
    const state: UxState = {
      errors: [],
      layoutScore: 0,
      layoutSupported: false,
    };
    uxWindow.__SKRIBEUM_UX__ = state;
    const stringify = (value: unknown): string => {
      if (value instanceof Error) {
        return `${value.name}: ${value.message}`;
      }
      if (typeof value === "string") {
        return value;
      }
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
    window.addEventListener("error", (event) => {
      state.errors.push(`window error: ${event.message}`.slice(0, 500));
    });
    window.addEventListener("unhandledrejection", (event) => {
      state.errors.push(
        `unhandled rejection: ${stringify(event.reason)}`.slice(0, 500),
      );
    });
    try {
      const supported =
        PerformanceObserver.supportedEntryTypes.includes("layout-shift");
      state.layoutSupported = supported;
      if (supported) {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            state.layoutScore += (
              entry as PerformanceEntry & { value: number }
            ).value;
          }
        }).observe({ type: "layout-shift", buffered: true });
      }
    } catch {
      state.layoutSupported = false;
    }
  });
}

async function armMeasurement(
  trigger: MeasurementTrigger,
  visible: Visibility,
): Promise<void> {
  await browser.execute(
    (triggerEvent, triggerKey, selectorTarget, textTarget) => {
      const state = (window as UxWindow).__SKRIBEUM_UX__;
      if (state === undefined) {
        return;
      }
      state.measurement?.cleanup();
      let startedAt: number | null = null;
      let pending = false;
      const measurement = { result: null as number | null, cleanup: () => {} };
      state.measurement = measurement;
      const visibleNow = (): boolean => {
        const target = document.querySelector(selectorTarget as string);
        return (
          target !== null &&
          (textTarget === null ||
            (target.textContent ?? "").includes(textTarget as string))
        );
      };
      const check = () => {
        if (
          startedAt === null ||
          pending ||
          measurement.result !== null ||
          !visibleNow()
        ) {
          return;
        }
        pending = true;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            measurement.result = performance.now() - (startedAt ?? 0);
            measurement.cleanup();
          }),
        );
      };
      const onTrigger = (event: Event) => {
        if (
          triggerKey !== null &&
          (!(event instanceof KeyboardEvent) || event.key !== triggerKey)
        ) {
          return;
        }
        startedAt = performance.now();
        check();
      };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      document.addEventListener(triggerEvent as string, onTrigger, true);
      measurement.cleanup = () => {
        observer.disconnect();
        document.removeEventListener(triggerEvent as string, onTrigger, true);
      };
    },
    trigger.event,
    trigger.key,
    visible.selector,
    visible.text,
  );
}

async function snapshot(expectedFocus: string[]): Promise<Snapshot> {
  return browser.execute(
    (
      focusSelectors: string[],
      scrolling: string[],
      rectangles: string[],
    ): Snapshot => {
      const state = (window as UxWindow).__SKRIBEUM_UX__;
      const active = document.activeElement as HTMLElement | null;
      const bodyFocus =
        active === null ||
        active === document.body ||
        active === document.documentElement;
      const descriptor = (() => {
        if (bodyFocus || active === null) {
          return "body";
        }
        const role = active.getAttribute("role") ?? "";
        const testId = active.dataset.testid ?? "";
        const label = active.getAttribute("aria-label") ?? "";
        const classes = [...active.classList].slice(0, 3).join(".");
        return `${active.tagName.toLowerCase()}:${role}:${testId}:${label}:${classes}`;
      })();
      const focusSensible =
        !bodyFocus &&
        (focusSelectors.length === 0 ||
          focusSelectors.some(
            (selector) =>
              active?.matches(selector) === true ||
              active?.closest(selector) !== null,
          ));
      const scroll = Object.fromEntries(
        scrolling.map((selector) => [
          selector,
          document.querySelector<HTMLElement>(selector)?.scrollTop ?? 0,
        ]),
      );
      const rectangleValues = Object.fromEntries(
        rectangles.flatMap((selector) => {
          const element = document.querySelector(selector);
          if (element === null) {
            return [];
          }
          const box = element.getBoundingClientRect();
          return [[selector, [box.left, box.top, box.width, box.height]]];
        }),
      ) as Record<string, [number, number, number, number]>;
      return {
        now: performance.now(),
        active: descriptor,
        bodyFocus,
        focusSensible,
        scroll,
        layoutScore: state?.layoutScore ?? 0,
        layoutSupported: state?.layoutSupported ?? false,
        rectangles: rectangleValues,
        consoleCount: state?.errors.length ?? 0,
      };
    },
    expectedFocus,
    scrollSelectors,
    rectangleSelectors,
  );
}

async function waitForVisibility(visible: Visibility): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (targetSelector, targetText, targetAbsent) => {
          const element = document.querySelector(targetSelector as string);
          const found =
            element !== null &&
            (targetText === null ||
              (element.textContent ?? "").includes(targetText as string));
          return (targetAbsent as boolean) === true ? !found : found;
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

async function settlePaint(): Promise<void> {
  await browser.execute(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

function geometryShift(before: Snapshot, after: Snapshot): number {
  const viewport = Math.max(1, 1280 * 800);
  let movement = 0;
  for (const [selector, beforeBox] of Object.entries(before.rectangles)) {
    const afterBox = after.rectangles[selector];
    if (afterBox === undefined) {
      continue;
    }
    const distance =
      Math.abs(afterBox[0] - beforeBox[0]) +
      Math.abs(afterBox[1] - beforeBox[1]);
    movement += distance * Math.max(beforeBox[2], beforeBox[3]);
  }
  return movement / viewport;
}

export class PersonaSession {
  readonly tracePath: string;
  private sequence = 0;
  private pacingState: number;

  constructor(
    readonly session: string,
    readonly persona: string,
    seed: number,
  ) {
    mkdirSync(tracesDirectory, { recursive: true });
    this.tracePath = path.join(tracesDirectory, `${session}.jsonl`);
    writeFileSync(this.tracePath, "");
    this.pacingState = seed >>> 0;
  }

  async interact(interaction: Interaction): Promise<TraceRecord> {
    const expectedFocus = interaction.expectedFocus ?? [];
    const before = await snapshot(expectedFocus);
    if (
      interaction.latencyKind !== undefined &&
      interaction.trigger !== undefined &&
      interaction.visible !== undefined &&
      interaction.visible.absent !== true
    ) {
      await armMeasurement(interaction.trigger, interaction.visible);
    }
    let status: "ok" | "error" = "ok";
    let error: string | null = null;
    try {
      await interaction.perform();
      if (interaction.visible !== undefined) {
        await waitForVisibility(interaction.visible);
      }
      await settlePaint();
    } catch (cause) {
      status = "error";
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const after = await snapshot(expectedFocus);
    const measured = await browser.execute(
      () => (window as UxWindow).__SKRIBEUM_UX__?.measurement?.result ?? null,
    );
    const consoleErrors = await browser.execute(
      (from: number) =>
        (window as UxWindow).__SKRIBEUM_UX__?.errors.slice(from) ?? [],
      before.consoleCount,
    );
    const deltaByContainer = Object.fromEntries(
      Object.entries(after.scroll).map(([selector, value]) => [
        selector,
        round(value - (before.scroll[selector] ?? 0)),
      ]),
    );
    const unexpectedPx = interaction.scrollExpected
      ? 0
      : Object.values(deltaByContainer).reduce(
          (sum, value) => sum + Math.abs(value),
          0,
        );
    const layoutScore = after.layoutSupported
      ? after.layoutScore - before.layoutScore
      : geometryShift(before, after);
    const record: TraceRecord = {
      v: 1,
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
                ms: round(measured ?? after.now - before.now),
                source:
                  measured === null ? "webdriver-fallback" : "event-to-paint",
              },
        focus: {
          before: before.active,
          after: after.active,
          sensible: after.focusSensible,
          body: after.bodyFocus,
        },
        scroll: {
          unexpectedPx: round(unexpectedPx),
          deltaByContainer,
        },
        layoutShift: {
          score: round(layoutScore, 4),
          method: after.layoutSupported ? "performance-observer" : "geometry",
        },
        consoleErrors,
        custom: (await interaction.custom?.()) ?? {},
      },
      error,
    };
    appendFileSync(this.tracePath, `${JSON.stringify(record)}\n`);
    await this.realisticPace();
    return record;
  }

  private async realisticPace(): Promise<void> {
    this.pacingState =
      (Math.imul(this.pacingState, 1_664_525) + 1_013_904_223) >>> 0;
    await browser.pause(20 + (this.pacingState % 41));
  }
}
