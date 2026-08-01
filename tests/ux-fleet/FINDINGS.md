# UX fleet findings

The deterministic fleet completed 8 persona sessions and recorded 147 intent-level interactions. The report ranks the ten highest-impact defects from 135 distinct signal breaches. A wrong screen ranks above a slow screen, so rendering failures precede latency, focus, scroll, and layout signals.

## Rendering defect coverage

| Check | Result |
| --- | --- |
| GFM tables show raw pipe syntax instead of a rendered table | Detected |
| Embeds show source references instead of embedded content | Detected |
| Fenced code has no syntax highlighting | Detected |
| Selection toolbar text does not contrast with its background | Detected |
| The editor caret is not visible against its background | Detected |
| Frontmatter appears in both the properties panel and the editor source | Passes |

The latency thresholds are exploratory triage thresholds, not release gates. Event-to-paint timing starts on the page event and ends at the next confirmed paint. The note threshold is above the 47 ms in-app p95 reference because this path includes UI dispatch and paint.

## 1. Critical: GFM tables show raw pipe syntax instead of a rendered table

- Persona: Checker
- Session: `08-checker`, interaction 50
- Measured signal: Expected semantic table output; observed semantic table output absent.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered tables.

## 2. Critical: Embeds show source references instead of embedded content

- Persona: Checker
- Session: `08-checker`, interaction 18
- Measured signal: Expected semantic embed output; observed semantic embed output absent.
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered embeds.

## 3. Critical: Fenced code has no syntax highlighting

- Persona: Checker
- Session: `08-checker`, interaction 54
- Measured signal: Expected at least two syntax token colors; observed rgb(23, 32, 51).
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered fenced-code.

## 4. Critical: Selection toolbar text does not contrast with its background

- Persona: Checker
- Session: `08-checker`, interaction 66
- Measured signal: Expected toolbar text contrast of at least 4.5:1; observed 1.04:1 (rgb(248, 250, 252) on rgb(245, 245, 245)).
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Measure caret, toolbar, and interactive chrome visibility.

## 5. Critical: The editor caret is not visible against its background

- Persona: Checker
- Session: `08-checker`, interaction 66
- Measured signal: Expected caret contrast of at least 3:1; observed 1.18:1 (rgb(0, 0, 0) on rgb(17, 24, 39)).
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Measure caret, toolbar, and interactive chrome visibility.

## 6. Critical: Callout: abstract does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 24
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: [!abstract].
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered callout-abstract.

## 7. Critical: Callout: bug does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 42
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: [!bug].
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered callout-bug.

## 8. Critical: Callout: danger does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 40
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: [!danger].
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered callout-danger.

## 9. Critical: Callout: example does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 44
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: [!example].
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered callout-example.

## 10. Critical: Callout: failure does not render as readable output

- Persona: Checker
- Session: `08-checker`, interaction 38
- Measured signal: Expected raw markers hidden while the cursor is elsewhere; observed visible source: [!failure].
- Reproduction:
  1. Run `bun run ux:fleet` to open the deterministic generated vault.
  2. Follow the Checker session intent: Verify that each visible construct matches its deterministic Markdown source.
  3. Assert rendered callout-failure.
