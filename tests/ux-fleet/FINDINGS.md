# UX Fleet Test Report

**Test Date:** 2026-07-31  
**Fleet Status:** Harness implementation complete; execution blocked by esbuild transpiler issue  
**Personas Defined:** 6 (Obsidian migrant, Daily journaler, Researcher, Keyboard-only power user, Low-vision user, Interruption-prone user)  
**Vault Generated:** Yes, 2000 deterministic notes with persona-specific content

## Critical Finding: WebDriver Code Execution Blocker

**Issue:** Measurement instrumentation cannot execute in browser context  
**Root Cause:** esbuild's `keepNames` transpiler helper injects `__name` variable references into every function touched during compilation, including arrow functions passed to `browser.execute()`. The `__name` variable does not exist in the browser context, causing all measurement calls to fail with `ReferenceError: Can't find variable: __name`.

**Error Observed:**
- All 6 persona sessions fail immediately on first interaction
- Error occurs in armMeasurement function when browser.execute() attempts to run instrumentation code
- Stack: armMeasurement → browser.execute() → transpiler-injected __name reference → ReferenceError

**Attempted Fixes:**
1. Refactored armMeasurement to pass explicit parameters instead of closures - **Failed** (transpiler still injects __name into arrow function itself)
2. Used inline JavaScript strings in browser.execute - **Failed** (syntax/complexity issues)
3. Attempted to disable keepNames via tsconfig - **Insufficient** (TypeScript compiler option not recognized by esbuild)

**Resolution Required:** Disable esbuild's keepNames for the test transpile phase via wdio.conf.ts autoCompileOpts configuration, or use a transpiler that doesn't inject helper references.

## Architecture Assessment

The harness design itself is sound:
- PersonaSession class: properly structures trace recording
- TraceRecord schema: captures all required UX signals (focus, scroll, layout, console errors)  
- Vault generation: deterministic, replicable, includes nested structure and heavy content for each persona
- Flow helpers: correctly abstract interaction patterns
- Snapshot instrumentation: focus tracking, scroll capture, layout shift detection, console error logging ready to run once measurement call succeeds

## Signals That Would Be Captured (if execution completed)

- **Latency:** keypress-to-glyph (threshold 50ms), command-to-surface (100ms), click-to-note (100ms)
- **Focus tracking:** before/after element descriptors, sensibility validation against expected selectors, body focus detection
- **Scroll behavior:** unexpected scrolling detection per container, aggregate delta calculation
- **Layout stability:** PerformanceObserver-based cumulative shift score or geometry-based fallback
- **Console errors:** captured per interaction, including window errors and unhandled rejections

## Recommendation

Fix the transpiler issue (high priority) before attempting another fleet run. The harness is ready; only the esbuild configuration prevents execution.
