# UX fleet findings

The deterministic fleet completed 6 persona sessions and recorded 56 intent-level interactions. The report ranks the ten highest-impact defects from 14 distinct signal breaches. Ranking weights blocked work and lost focus above latency, scroll movement, and visual stability, independent of how often a signal occurred.

The latency thresholds are exploratory triage thresholds, not release gates. Event-to-paint timing starts on the page event and ends at the next confirmed paint. The note threshold is deliberately above the 47 ms in-app p95 reference because this path includes UI dispatch and paint.

## 1. Critical: The UI session cannot complete: Press Enter to insert a table

- Persona: Researcher with long documents
- Session: `03-researcher`, interaction 10
- Measured signal: visibility condition failed for .cm-content
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Researcher with long documents session intent: Review a long document, paste evidence, search within it, and edit tables.
  3. Press Enter to insert a table.

## 2. High: Visible typing response is delayed while users paste an 80-paragraph evidence extract

- Persona: Researcher with long documents
- Session: `03-researcher`, interaction 4
- Measured signal: Visible typing response: 106.00 ms (event-to-paint); exploratory threshold: 50 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Researcher with long documents session intent: Review a long document, paste evidence, search within it, and edit tables.
  3. Paste an 80-paragraph evidence extract.

## 3. High: Content scrolls without a scroll command while users paste an 80-paragraph evidence extract

- Persona: Researcher with long documents
- Session: `03-researcher`, interaction 4
- Measured signal: Unexpected aggregate scrollTop delta: 1401 px.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Researcher with long documents session intent: Review a long document, paste evidence, search within it, and edit tables.
  3. Paste an 80-paragraph evidence extract.

## 4. High: Content scrolls without a scroll command while users press enter to open keyboard/command surface.md

- Persona: Keyboard-only power user
- Session: `04-keyboard-power-user`, interaction 3
- Measured signal: Unexpected aggregate scrollTop delta: 1401 px.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Keyboard-only power user session intent: Navigate core command surfaces without pointer input and preserve useful focus.
  3. Press Enter to open Keyboard/Command Surface.md.

## 5. High: Surface appearance is delayed while users press ctrl+o to open the quick switcher

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 2
- Measured signal: Surface appearance: 837.00 ms (event-to-paint); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Ctrl+O to open the quick switcher.

## 6. Medium: First painted note content is delayed while users press enter to open research/long paper.md

- Persona: Researcher with long documents
- Session: `03-researcher`, interaction 3
- Measured signal: First painted note content: 144.00 ms (event-to-paint); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Researcher with long documents session intent: Review a long document, paste evidence, search within it, and edit tables.
  3. Press Enter to open Research/Long Paper.md.

## 7. Medium: Surface appearance is delayed while users press ctrl+shift+f to search the imported vault

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 5
- Measured signal: Surface appearance: 166.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Ctrl+Shift+F to search the imported vault.

## 8. Medium: Surface appearance is delayed while users open the quick switcher to revisit recent notes

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 8
- Measured signal: Surface appearance: 107.00 ms (event-to-paint); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Open the quick switcher to revisit recent notes.

## 9. Medium: Surface appearance is delayed while users press ctrl+o to open the quick switcher

- Persona: Daily journaler
- Session: `02-daily-journaler`, interaction 1
- Measured signal: Surface appearance: 138.00 ms (event-to-paint); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Daily journaler session intent: Capture a daily entry, add links quickly, and move between linked notes.
  3. Press Ctrl+O to open the quick switcher.

## 10. Medium: Surface appearance is delayed while users press ctrl+o to open the quick switcher

- Persona: Daily journaler
- Session: `02-daily-journaler`, interaction 7
- Measured signal: Surface appearance: 110.00 ms (event-to-paint); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Daily journaler session intent: Capture a daily entry, add links quickly, and move between linked notes.
  3. Press Ctrl+O to open the quick switcher.
