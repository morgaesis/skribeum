// biome-ignore-all format: Keep the exploratory harness within its line budget.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TraceRecord, VisualCheck } from "./signals";

type Impact = "Critical" | "High" | "Medium";

type Finding = {
  key: string;
  score: number;
  impact: Impact;
  title: string;
  measured: string;
  record: TraceRecord;
};

const tracesDirectory = path.join(import.meta.dirname, "traces");
const findingsPath = path.join(import.meta.dirname, "FINDINGS.md");
const writeFindings = process.argv.includes("--write-findings");

function loadTraces(): TraceRecord[] {
  return readdirSync(tracesDirectory)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) =>
      readFileSync(path.join(tracesDirectory, name), "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as TraceRecord),
    );
}

function impactFor(score: number): Impact {
  if (score >= 90) {
    return "Critical";
  }
  if (score >= 70) {
    return "High";
  }
  return "Medium";
}

function addFinding(findings: Finding[], record: TraceRecord, key: string, score: number, title: string, measured: string, unique = false): void {
  findings.push({
    key: unique ? key : `${key}:${record.session}:${record.seq}`,
    score,
    impact: impactFor(score),
    title,
    measured,
    record,
  });
}

const knownVisual = [
  {
    key: "tables",
    match: (id: string) => id.startsWith("tables-"),
    title: "GFM tables show raw pipe syntax instead of a rendered table",
  },
  {
    key: "embeds",
    match: (id: string) => id.startsWith("embeds-"),
    title: "Embeds show source references instead of embedded content",
  },
  {
    key: "code-highlighting",
    match: (id: string) => id === "fenced-code-code",
    title: "Fenced code has no syntax highlighting",
  },
  {
    key: "toolbar-contrast",
    match: (id: string) => id === "toolbar-contrast",
    title: "Selection toolbar text does not contrast with its background",
  },
  {
    key: "caret-visibility",
    match: (id: string) => id === "caret-contrast",
    title: "The editor caret is not visible against its background",
  },
  {
    key: "frontmatter-duplication",
    match: (id: string) => id === "frontmatter-frontmatter",
    title: "Frontmatter appears in both the properties panel and the editor source",
  },
] as const;

function visualDetails(check: VisualCheck): {
  key: string;
  score: number;
  title: string;
} {
  const known = knownVisual.find((item) => item.match(check.id));
  return known === undefined
    ? {
        key: `visual-${check.id}`,
        score: 105,
        title: `${check.construct} does not render as readable output`,
      }
    : {
        key: `visual-${known.key}`,
        score: 120 - knownVisual.indexOf(known),
        title: known.title,
      };
}

function findingsFrom(records: TraceRecord[]): Finding[] {
  const findings: Finding[] = [];
  for (const record of records) {
    const { signal } = record;
    for (const check of signal.visual.filter((item) => !item.pass)) {
      const details = visualDetails(check);
      addFinding(findings, record, details.key, details.score, details.title, `Expected ${check.expected}; observed ${check.actual}.`, true);
    }
    if (record.status === "error") {
      addFinding(findings, record, "failed-action", 100, `The UI session cannot complete: ${record.action}`, record.error ?? "The interaction failed without an error message.");
      continue;
    }
    if (signal.consoleErrors.length > 0) {
      addFinding(
        findings,
        record,
        "console-error",
        95,
        `The UI emits an error while users ${record.action.toLowerCase()}`,
        `${signal.consoleErrors.length} console error${signal.consoleErrors.length === 1 ? "" : "s"}: ${signal.consoleErrors[0]}`,
      );
    }
    const tabIsSimulated = signal.custom.nativeTabTraversal === false;
    if (signal.focus.body && !tabIsSimulated) {
      addFinding(findings, record, "body-focus", 92, `Focus falls back to the document body after users ${record.action.toLowerCase()}`, `Active element: ${signal.focus.after}.`);
    } else if (!signal.focus.sensible && !tabIsSimulated) {
      addFinding(findings, record, "misplaced-focus", 82, `Focus does not land on the expected control after users ${record.action.toLowerCase()}`, `Focus moved from ${signal.focus.before} to ${signal.focus.after}.`);
    }
    const overflow = signal.custom.horizontalOverflowPx;
    if (typeof overflow === "number" && overflow > 0) {
      addFinding(findings, record, "zoom-overflow", 86, "The application overflows horizontally at 200 percent page zoom", `Horizontal overflow: ${overflow.toFixed(0)} px.`);
    }
    if (signal.scroll.unexpectedPx > 8) {
      addFinding(findings, record, "scroll-jump", 74, `Content scrolls without a scroll command while users ${record.action.toLowerCase()}`, `Unexpected aggregate scrollTop delta: ${signal.scroll.unexpectedPx.toFixed(0)} px.`);
    }
    if (signal.layoutShift.score > 0.01 && (signal.latency?.kind === "note" || signal.latency?.kind === "glyph")) {
      addFinding(findings, record, "layout-shift", 72, `Content shifts after users ${record.action.toLowerCase()}`, `Layout-shift score: ${signal.layoutShift.score.toFixed(4)} by ${signal.layoutShift.method}.`);
    }
    const latency = signal.latency;
    if (latency === null) {
      continue;
    }
    const threshold = latency.kind === "glyph" ? 50 : latency.kind === "note" ? 100 : 100;
    if (latency.ms <= threshold) {
      continue;
    }
    const labels = {
      glyph: "Visible typing response",
      note: "First painted note content",
      surface: "Surface appearance",
    } as const;
    const score = latency.kind === "glyph" ? 80 : latency.kind === "note" ? 68 : 62;
    addFinding(
      findings,
      record,
      `slow-${latency.kind}`,
      score + Math.min(8, Math.floor(latency.ms / threshold)),
      `${labels[latency.kind]} is delayed while users ${record.action.toLowerCase()}`,
      `${labels[latency.kind]}: ${latency.ms.toFixed(2)} ms (${latency.source}); exploratory threshold: ${threshold} ms.`,
    );
  }
  const sorted = findings.sort((left, right) => right.score - left.score || right.record.signal.layoutShift.score - left.record.signal.layoutShift.score || left.key.localeCompare(right.key));
  return [...new Map(sorted.map((finding) => [finding.key, finding])).values()];
}

function renderFindings(records: TraceRecord[], findings: Finding[]): string {
  const sessions = new Set(records.map((record) => record.session)).size;
  const selected = findings.slice(0, 10);
  const countStatement =
    findings.length < 10
      ? `The fleet found ${findings.length} distinct signal-backed defects, so this report contains fewer than ten findings.`
      : `The report ranks the ten highest-impact defects from ${findings.length} distinct signal breaches.`;
  const sections = selected.map((finding, index) => {
    const record = finding.record;
    return `## ${index + 1}. ${finding.impact}: ${finding.title}\n\n- Persona: ${record.persona}\n- Session: \`${record.session}\`, interaction ${record.seq}\n- Measured signal: ${finding.measured}\n- Reproduction:\n  1. Run \`bun run ux:fleet\` to open the deterministic generated vault.\n  2. Follow the ${record.persona} session intent: ${record.intent}.\n  3. ${record.action}.`;
  });
  const checks = records.flatMap((record) => record.signal.visual);
  const coverage = knownVisual
    .map((known) => {
      const matching = checks.filter((check) => known.match(check.id));
      const status = matching.length === 0 ? "Not exercised" : matching.some((check) => !check.pass) ? "Detected" : "Passes";
      return `| ${known.title} | ${status} |`;
    })
    .join("\n");
  return `# UX fleet findings\n\nThe deterministic fleet completed ${sessions} persona sessions and recorded ${records.length} intent-level interactions. ${countStatement} A wrong screen ranks above a slow screen, so rendering failures precede latency, focus, scroll, and layout signals.\n\n## Rendering defect coverage\n\n| Check | Result |\n| --- | --- |\n${coverage}\n\nThe latency thresholds are exploratory triage thresholds, not release gates. Event-to-paint timing starts on the page event and ends at the next confirmed paint. The note threshold is above the 47 ms in-app p95 reference because this path includes UI dispatch and paint.\n\n${sections.join("\n\n")}\n`;
}

const records = loadTraces();
const findings = findingsFrom(records);
if (writeFindings) {
  writeFileSync(findingsPath, renderFindings(records, findings));
}

const top = findings.slice(0, 5).map((finding, index) => ({
  rank: index + 1,
  impact: finding.impact,
  title: finding.title,
  measured: finding.measured,
  session: finding.record.session,
  interaction: finding.record.seq,
}));
console.log(
  JSON.stringify(
    {
      sessions: new Set(records.map((record) => record.session)).size,
      interactions: records.length,
      findings: findings.length,
      reported: Math.min(10, findings.length),
      top,
    },
    null,
    2,
  ),
);
