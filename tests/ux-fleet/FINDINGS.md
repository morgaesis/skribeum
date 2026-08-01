# UX fleet findings

The deterministic fleet completed 8 persona sessions and recorded 147 intent-level interactions. The report ranks the ten highest-impact defects from 123 distinct signal breaches. A wrong screen ranks above a slow screen, so rendering failures precede latency, focus, scroll, and layout signals.

## Rendering defect coverage

| Check | Result |
| --- | --- |
| GFM tables show raw pipe syntax instead of a rendered table | Detected |
| Embeds show source references instead of embedded content | Detected |
| Fenced code has no syntax highlighting | Passes |
| Selection toolbar text does not contrast with its background | Passes |
| The editor caret is not visible against its background | Passes |
| Frontmatter appears in both the properties panel and the editor source | Passes |

The latency thresholds are exploratory triage thresholds, not release gates. Event-to-paint timing starts on the page event and ends at the next confirmed paint. The note threshold is above the 47 ms in-app p95 reference because this path includes UI dispatch and paint.

## 1. Critical: GFM tables show raw pipe syntax instead of a rendered table

- Persona: Checker
- Session: `08-checker`, interaction 8
- Measured signal: Expected visible long-table rows without pipe syntax; observed raw pipe syntax visible.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Scroll through a long note.

## 2. Critical: Embeds show source references instead of embedded content

- Persona: Checker
- Session: `08-checker`, interaction 18
- Measured signal: Expected semantic embed output; observed semantic embed output absent.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered embeds.

## 3. Critical: Canvas does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 63
- Measured signal: Expected raw canvas JSON and card Markdown hidden; observed visible source: <!-- # Quickstart -->.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered canvas.

## 4. Critical: Fenced code does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 54
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: ```ts.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered fenced-code.

## 5. Critical: Tags does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 20
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: #project/cedar-room.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered tags.

## 6. Critical: Wikilinks does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 2
- Measured signal: Expected the linked note opens; observed click did not navigate.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Click a rendered link and expect navigation.

## 7. Critical: The UI session cannot complete: Open Search vault

- Persona: Obsidian migrant
- Session: `01-obsidian-migrant`, interaction 3
- Measured signal: visibility condition failed for [aria-label="Search vault"]
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Obsidian migrant session intent: Audit a 2000-note imported vault and reach deeply nested material.
  3. Open Search vault.

## 8. Critical: The UI session cannot complete: Open Command palette

- Persona: Keyboard-only power user
- Session: `04-keyboard-power-user`, interaction 3
- Measured signal: visibility condition failed for [aria-label="Command palette"]
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Keyboard-only power user session intent: Navigate core command surfaces without pointer input and preserve useful focus.
  3. Open Command palette.

## 9. Critical: The UI session cannot complete: Open Command palette

- Persona: Low-vision user
- Session: `05-low-vision`, interaction 4
- Measured signal: visibility condition failed for [aria-label="Command palette"]
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Low-vision user session intent: Use dark theme at 200 percent page zoom without clipping or lost focus.
  3. Open Command palette.

## 10. Critical: The UI session cannot complete: Open Command palette

- Persona: Interruption-prone user
- Session: `06-interruption-prone`, interaction 4
- Measured signal: visibility condition failed for [aria-label="Command palette"]
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Interruption-prone user session intent: Switch notes during edits and dismiss transient surfaces at unpredictable points.
  3. Open Command palette.
