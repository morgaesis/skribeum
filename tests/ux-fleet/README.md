# Skribeum UX fleet

The UX fleet is an exploratory, headless WebDriver harness over a deterministic 2,000-note copy of the demo vault. It records realistic persona sessions and checks whether Markdown is visibly rendered, not merely present in the editor document.

The fleet stays outside the CI gate. Its screenshots and timing signals depend on the local WebView and display stack, while its findings are intended for human triage.

## Run

```bash
bun run ux:fleet
```

The runner builds the WebDriver application, starts it under `xvfb` with an isolated runtime profile, runs all persona sessions, writes JSONL traces, generates `FINDINGS.md`, and creates the screenshot gallery at `screenshots/index.md`.

Use an existing compatible debug build while iterating on the harness:

```bash
bun tests/ux-fleet/run.ts --skip-build
```

## Personas

The fleet retains the Obsidian migrant, daily journaler, researcher, keyboard-only power user, low-vision user, and interruption-prone user. It also includes:

- Skimmer: reads and navigates without typing or editing.
- Checker: compares every visible construct with deterministic source content.

Every persona opens the demo vault, follows a rendered link, hovers a code block for its copy affordance, attempts to collapse and expand frontmatter, scrolls a long note, changes theme, and uses wide and narrow windows.

## Rendering assertions

The checker covers six heading levels, emphasis, wikilinks, embeds, tags, every primary callout type, tasks, GFM tables, inline and fenced code, inline and block math, frontmatter properties, and canvas files. Each construct check records three independent conditions:

1. The semantic rendered element exists.
2. Source markers are absent while the cursor is elsewhere.
3. Visible text matches rendered content rather than source syntax.

Construct-specific checks verify table semantics, embedded content, syntax token colors, frontmatter source suppression, canvas cards, and the code-copy affordance. Failed visual checks are findings and do not abort the exploratory session.

Computed-style checks measure caret contrast, selection-toolbar text contrast, and visible interactive chrome. These checks do not rely on axe because semantic accessibility rules can pass when inherited colors make a control unreadable.

## Screenshot evidence

`screenshots/index.md` links every persona and construct screenshot in light and dark themes at wide and narrow viewports. The directory is gitignored because each fleet run regenerates the evidence.

The `references/` directory contains a small committed pixel baseline for headings, inline math, and canvas. Comparison permits up to 3 percent of pixels to differ by more than 32 RGB levels, which tolerates modest font rasterization differences while catching structural changes.

Update references deliberately after reviewing the generated screenshots:

```bash
bun tests/ux-fleet/run.ts --bless
```

## Trace format

Each interaction appends one version 2 record under `traces/`. Records contain latency, focus, scroll, layout shift, console errors, visual checks, and persona-specific scalar signals. `trace.schema.json` defines the format.

Rendering failures rank above latency failures in `FINDINGS.md`. A wrong screen is more severe than a slow screen.

## Limits

The fleet cannot measure operating-system caret compositing, native clipboard completion, IME composition, assistive-technology speech output, or physical input feel. Computed caret contrast is the closest stable WebView-level signal. Pixel references cover only low-motion surfaces with deterministic content; the rest of the rendering surface remains screenshot-backed to avoid brittle regressions.
