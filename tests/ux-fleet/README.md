# Skribeum UX Fleet

A persona-driven testing harness that exercises the Skribeum UI through realistic user workflows to detect touch-and-feel defects.

## Overview

The UX fleet simulates six distinct user personas interacting with Skribeum against a deterministic 2000-note vault. Each persona follows a realistic workflow with measured latency, focus transitions, scroll behavior, and console error capture.

## Personas

1. **Obsidian Migrant** - Audits a large imported vault and navigates deeply nested material via the quick switcher and search
2. **Daily Journaler** - Captures daily entries, creates rapid wikilinks, and follows linked references
3. **Researcher** - Reviews long documents, pastes evidence extracts, searches within notes, and inserts tables
4. **Keyboard-Only Power User** - Navigates all core surfaces without mouse input, using Tab, Enter, and command palette
5. **Low-Vision User** - Operates with 200% page zoom and dark theme, checking for clipping and focus visibility
6. **Interruption-Prone User** - Switches notes mid-edit, dismisses transient surfaces, and tests unsaved state handling

## Running the Fleet

### Prerequisites

- Node.js / Bun
- WebdriverIO with Tauri service
- xvfb (for headless execution)
- WebKitGTK driver or equivalent

### Quick Start

```bash
bun tests/ux-fleet/run.ts
```

This runs the full fleet under headless xvfb and prints a summary of findings.

### Direct WebdriverIO Execution

```bash
npx wdio run tests/ux-fleet/wdio.conf.ts
```

## Signals Measured

Each interaction records:

- **Latency** - Time from event trigger to visible result (glyph, surface, or note opening)
  - Source: event-to-paint measurement or WebDriver fallback timing
  - Kinds: `glyph` (keypress to character), `surface` (command to UI), `note` (click to content)

- **Focus** - Element with keyboard focus before/after interaction
  - Tracks whether focus landed on expected element
  - Flags focus landing on document.body (usually a defect)

- **Scroll** - Unexpected scrolling caused by interactions
  - Captures scroll deltas per container (editor, sidebar, listbox, outline)
  - Flags unintended scroll jumps

- **Layout Shift** - Cumulative layout instability score
  - Measured via PerformanceObserver if available
  - Falls back to bounding box geometry comparison

- **Console Errors** - JavaScript errors, unhandled rejections, and console.error calls
  - Captured per interaction
  - Truncated to 500 chars

- **Custom Signals** - Persona-specific measurements (zoom overflow, tab traversal results, etc.)

## Trace Format

Traces are stored in `tests/ux-fleet/traces/` as JSONL files (one JSON record per line):

```typescript
type TraceRecord = {
  v: 1;
  session: string;              // e.g., "01-obsidian-migrant"
  persona: string;              // e.g., "Obsidian migrant"
  seq: number;                  // interaction sequence number
  intent: string;               // high-level user goal
  action: string;               // specific action taken
  status: "ok" | "error";       // whether the action succeeded
  signal: {
    latency: {
      kind: "glyph" | "surface" | "note";
      ms: number;               // milliseconds
      source: "event-to-paint" | "webdriver-fallback";
    } | null;
    focus: {
      before: string;           // descriptor before action
      after: string;            // descriptor after action
      sensible: boolean;        // matches expectedFocus selectors
      body: boolean;           // focus on document.body
    };
    scroll: {
      unexpectedPx: number;    // sum of absolute scroll deltas
      deltaByContainer: Record<string, number>;
    };
    layoutShift: {
      score: number;           // cumulative shift score
      method: "performance-observer" | "geometry";
    };
    consoleErrors: string[];   // errors captured during interaction
    custom: Record<string, boolean | number | string | null>;
  };
  error: string | null;        // exception message if status is "error"
};
```

## Findings Report

After running the fleet, see `FINDINGS.md` for the ranked report of discovered UX defects.

## Architecture

- **vault.ts** - Deterministic vault generator (seeded, 2000 notes, special persona-specific notes)
- **signals.ts** - UX instrumentation and trace recording (PersonaSession, measurement timing, snapshot collection)
- **personas.spec.ts** - Six persona test cases using WebdriverIO's BDD interface
- **wdio.conf.ts** - WebdriverIO config that extends the existing e2e setup and overrides specs/timeouts
- **run.ts** - Runner script that executes the fleet headlessly and prints findings summary

## Design Rationale

- **Persona-driven intent** - Each session models realistic user goals, not low-level UI assertions
- **Deterministic vault** - Seeded generation ensures reproducible large-vault behavior
- **No wall-clock sleeps** - Realistic pacing via a PRNG; no hardcoded waits that mask real timing issues
- **Headless under xvfb** - Runs in CI without display server, avoiding brittle screenshot comparisons
- **JSONL trace format** - Line-delimited JSON for streaming, easy aggregation, and grep-friendly inspection
- **Signal ranking** - Findings ranked by user impact, not frequency; a single layout shift in a common workflow matters more than repeated scroll errors in edge cases

## Constraints and Known Limits

- Cannot measure platform-specific OS-level latency (copy/paste system clipboard, IME composition)
- Performance metrics depend on system load during test run; xvfb helps but isn't perfectly isolated
- Focus testing relies on DOM-level focus; native title bar or OS-level focus changes not captured
- Layout shift measurement requires PerformanceObserver support in the WebView runtime
- Large vault (2000 notes) may expose scalability issues not seen in smaller test vaults

## Future Improvements

- Add trace filtering/grouping by latency bucket (< 50ms, 50-200ms, > 200ms)
- Implement differential analysis (compare runs to detect regressions)
- Extend personas with accessibility tools (screen reader emulation, high-contrast mode verification)
- Add visual regression detection via screenshot diffing
