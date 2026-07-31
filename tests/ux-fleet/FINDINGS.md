# UX fleet findings

The deterministic fleet completed 2 persona sessions and recorded 12 intent-level interactions. The fleet found 9 distinct signal-backed defects, so this report contains fewer than ten findings. Ranking weights blocked work and lost focus above latency, scroll movement, and visual stability, independent of how often a signal occurred.

The latency thresholds are exploratory triage thresholds, not release gates. Event-to-paint timing starts on the page event and ends at the next confirmed paint. The note threshold is deliberately above the 47 ms in-app p95 reference because this path includes UI dispatch and paint.

## 1. Critical: The UI session cannot complete: Press Enter to open Archive/Imported/Department-07/Area-04/Project-03/Topic-02/Deep Note 0199.md

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 4
- Measured signal: visibility failed for .cm-content
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Enter to open Archive/Imported/Department-07/Area-04/Project-03/Topic-02/Deep Note 0199.md.

## 2. High: Focus does not land on the expected control after users press ctrl+o to open the quick switcher

- Persona: Daily journaler
- Session: `02-daily-journaler`, interaction 1
- Measured signal: Focus moved from div:textbox::Note editor:cm-content.cm-lineWrapping to input:combobox::Search vault:w-full.rounded-t-lg.border-b.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Daily journaler session intent: Capture a daily entry, add links quickly, and move between linked notes.
  3. Press Ctrl+O to open the quick switcher.

## 3. High: Surface appearance is delayed while users press ctrl+o to open the quick switcher

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 2
- Measured signal: Surface appearance: 865.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Ctrl+O to open the quick switcher.

## 4. High: Surface appearance is delayed while users open the quick switcher to revisit recent notes

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 8
- Measured signal: Surface appearance: 3660.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Open the quick switcher to revisit recent notes.

## 5. High: Surface appearance is delayed while users press ctrl+o to open the quick switcher

- Persona: Daily journaler
- Session: `02-daily-journaler`, interaction 1
- Measured signal: Surface appearance: 3600.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Daily journaler session intent: Capture a daily entry, add links quickly, and move between linked notes.
  3. Press Ctrl+O to open the quick switcher.

## 6. Medium: First painted note content is delayed while users press enter to open archive/imported/department-07/area-04/project-03/topic-02/deep note 0199.md

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 4
- Measured signal: First painted note content: 109.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Enter to open Archive/Imported/Department-07/Area-04/Project-03/Topic-02/Deep Note 0199.md.

## 7. Medium: First painted note content is delayed while users press enter on the ranked deep-note result

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 7
- Measured signal: First painted note content: 128.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Enter on the ranked deep-note result.

## 8. Medium: Surface appearance is delayed while users press ctrl+shift+f to search the imported vault

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 5
- Measured signal: Surface appearance: 307.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Ctrl+Shift+F to search the imported vault.

## 9. Medium: Surface appearance is delayed while users press ctrl+shift+f to search the imported vault

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 5
- Measured signal: Surface appearance: 105.00 ms (webdriver-fallback); exploratory threshold: 100 ms.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Press Ctrl+Shift+F to search the imported vault.
