import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

async function analyzeTraces(): Promise<void> {
  const tracesDir = path.join(import.meta.dirname, "traces");
  if (!existsSync(tracesDir)) {
    console.log("No traces directory found.");
    return;
  }

  const traceFiles = readdirSync(tracesDir).filter((f) => f.endsWith(".jsonl"));
  if (traceFiles.length === 0) {
    console.log("No trace files found.");
    return;
  }

  const findings: Record<
    string,
    { persona: string; count: number; samples: string[] }
  > = {};

  for (const file of traceFiles) {
    const filePath = path.join(tracesDir, file);
    const content = readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (record.status === "error" || record.signal.consoleErrors.length > 0) {
        const key = record.intent;
        if (!findings[key]) {
          findings[key] = { persona: record.persona, count: 0, samples: [] };
        }
        findings[key].count += 1;
        if (findings[key].samples.length < 3) {
          findings[key].samples.push(
            `${record.action} (latency: ${record.signal.latency?.ms ?? 0}ms)`,
          );
        }
      }
    }
  }

  console.log(`\nUX Fleet Findings Summary\n${"=".repeat(50)}`);
  const sorted = Object.entries(findings)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 10);

  if (sorted.length === 0) {
    console.log("No UX defects detected in this run.");
    return;
  }

  for (let i = 0; i < sorted.length; i++) {
    const [intent, finding] = sorted[i];
    console.log(
      `\n${i + 1}. [${finding.persona}] ${intent} (${finding.count} occurrences)`,
    );
    for (const sample of finding.samples) {
      console.log(`   - ${sample}`);
    }
  }
}

console.log("Running UX fleet under headless xvfb...");
const cwd = path.resolve(import.meta.dirname, "../..");
try {
  execSync("xvfb-run -a npx wdio run tests/ux-fleet/wdio.conf.ts", {
    stdio: "inherit",
    cwd,
    env: { ...process.env, PATH: process.env.PATH },
  });
} catch (error) {
  console.error(
    "Fleet execution failed:",
    error instanceof Error ? error.message : error,
  );
  process.exit(1);
}

await analyzeTraces();
