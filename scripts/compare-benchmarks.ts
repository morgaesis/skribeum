#!/usr/bin/env bun

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const DEFAULT_WINDOW = 5;
const DEFAULT_THRESHOLD_PERCENT = 10;

type BenchmarkSamples = {
  samples_ns: number[];
};

type BenchmarkFile = {
  schema: 1;
  runner_class?: string;
  window: number;
  threshold_percent: number;
  benchmarks: Record<string, BenchmarkSamples>;
};

type Arguments = {
  baseline: string;
  current?: string;
  criterionDir?: string;
  window?: number;
  thresholdPercent?: number;
  refreshBaseline: boolean;
};

function usage(): string {
  return `Usage: bun scripts/compare-benchmarks.ts --baseline FILE (--current FILE | --criterion-dir DIR) [options]

Compares rolling medians of benchmark samples. A positive relative change
above the threshold fails with exit code 1.

Options:
  --window N              Number of trailing samples in each median
  --threshold-percent N   Maximum allowed slowdown
  --refresh-baseline      Append current medians to the rolling baseline
  --help                  Show this message`;
}

function fail(message: string): never {
  console.error(`benchmark comparison error: ${message}`);
  process.exit(2);
}

function parseArguments(argv: string[]): Arguments {
  const refreshBaseline = argv.includes("--refresh-baseline");
  argv = argv.filter((argument) => argument !== "--refresh-baseline");
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (!argument.startsWith("--")) {
      fail(`unexpected argument ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`missing value for ${argument}`);
    }
    values.set(argument, value);
    index += 1;
  }

  const baseline = values.get("--baseline");
  const current = values.get("--current");
  const criterionDir = values.get("--criterion-dir");
  if (!baseline) {
    fail("--baseline is required");
  }
  if ((current === undefined) === (criterionDir === undefined)) {
    fail("exactly one of --current and --criterion-dir is required");
  }

  const window = parsePositiveNumber(values.get("--window"), "--window");
  const thresholdPercent = parseNonNegativeNumber(
    values.get("--threshold-percent"),
    "--threshold-percent",
  );
  if (refreshBaseline && criterionDir === undefined) {
    fail("--refresh-baseline requires --criterion-dir");
  }
  return {
    baseline,
    current,
    criterionDir,
    window,
    thresholdPercent,
    refreshBaseline,
  };
}

function parsePositiveNumber(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeNumber(
  value: string | undefined,
  flag: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    fail(`${flag} must be a non-negative number`);
  }
  return parsed;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    fail(
      `cannot read JSON file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateBenchmarkFile(value: unknown, label: string): BenchmarkFile {
  if (typeof value !== "object" || value === null) {
    fail(`${label} must be a JSON object`);
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schema !== 1 ||
    typeof candidate.window !== "number" ||
    typeof candidate.threshold_percent !== "number"
  ) {
    fail(`${label} has an unsupported schema`);
  }
  if (
    typeof candidate.benchmarks !== "object" ||
    candidate.benchmarks === null
  ) {
    fail(`${label}.benchmarks must be an object`);
  }
  const benchmarks: Record<string, BenchmarkSamples> = {};
  for (const [name, raw] of Object.entries(
    candidate.benchmarks as Record<string, unknown>,
  )) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      !Array.isArray((raw as Record<string, unknown>).samples_ns)
    ) {
      fail(`${label}.benchmarks.${name}.samples_ns must be an array`);
    }
    const samples = (raw as { samples_ns: unknown[] }).samples_ns;
    if (
      samples.length === 0 ||
      samples.some(
        (sample) =>
          typeof sample !== "number" || !Number.isFinite(sample) || sample <= 0,
      )
    ) {
      fail(
        `${label}.benchmarks.${name}.samples_ns must contain positive finite numbers`,
      );
    }
    benchmarks[name] = { samples_ns: samples as number[] };
  }
  return {
    schema: 1,
    ...(typeof candidate.runner_class === "string"
      ? { runner_class: candidate.runner_class }
      : {}),
    window: candidate.window,
    threshold_percent: candidate.threshold_percent,
    benchmarks,
  };
}

function rollingMedian(samples: number[], window: number): number {
  const trailing = samples
    .slice(-window)
    .toSorted((left, right) => left - right);
  const middle = Math.floor(trailing.length / 2);
  return trailing.length % 2 === 0
    ? (trailing[middle - 1] + trailing[middle]) / 2
    : trailing[middle];
}

async function criterionSamples(root: string): Promise<BenchmarkFile> {
  const benchmarks: Record<string, BenchmarkSamples> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
        continue;
      }
      if (entry.name !== "estimates.json" || !directory.endsWith(`${sep}new`)) {
        continue;
      }
      const raw = await readJson(path);
      if (typeof raw !== "object" || raw === null) {
        fail(`${path} must be a JSON object`);
      }
      const estimates = raw as Record<string, unknown>;
      const median = estimates.median;
      if (
        typeof median !== "object" ||
        median === null ||
        typeof (median as Record<string, unknown>).point_estimate !== "number"
      ) {
        fail(`${path} has no Criterion median point estimate`);
      }
      const key = relative(root, directory.slice(0, -`${sep}new`.length))
        .split(sep)
        .join("/");
      benchmarks[key] = {
        samples_ns: [(median as { point_estimate: number }).point_estimate],
      };
    }
  }

  await visit(root);
  return {
    schema: 1,
    window: DEFAULT_WINDOW,
    threshold_percent: DEFAULT_THRESHOLD_PERCENT,
    benchmarks,
  };
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  const baseline = validateBenchmarkFile(
    await readJson(arguments_.baseline),
    "baseline",
  );
  const current = arguments_.current
    ? validateBenchmarkFile(await readJson(arguments_.current), "current")
    : arguments_.criterionDir
      ? await criterionSamples(arguments_.criterionDir)
      : fail("exactly one of --current and --criterion-dir is required");
  const window = arguments_.window ?? baseline.window ?? DEFAULT_WINDOW;
  const thresholdPercent =
    arguments_.thresholdPercent ??
    baseline.threshold_percent ??
    DEFAULT_THRESHOLD_PERCENT;

  if (arguments_.refreshBaseline) {
    for (const name of Object.keys(baseline.benchmarks)) {
      const sample = current.benchmarks[name]?.samples_ns.at(-1);
      if (sample === undefined) {
        fail(`current results are missing benchmark ${name}`);
      }
      baseline.benchmarks[name].samples_ns = [
        ...baseline.benchmarks[name].samples_ns,
        sample,
      ].slice(-window);
    }
    baseline.window = window;
    baseline.threshold_percent = thresholdPercent;
    await writeFile(
      arguments_.baseline,
      `${JSON.stringify(baseline, null, 2)}\n`,
    );
    console.log(`refreshed ${arguments_.baseline}`);
    return;
  }
  const failures: string[] = [];

  for (const name of Object.keys(baseline.benchmarks).toSorted()) {
    const baselineSamples = baseline.benchmarks[name].samples_ns;
    const currentSamples = current.benchmarks[name]?.samples_ns;
    if (!currentSamples) {
      fail(`current results are missing benchmark ${name}`);
    }
    const baselineMedian = rollingMedian(baselineSamples, window);
    const currentMedian = rollingMedian(currentSamples, window);
    const relativePercent =
      ((currentMedian - baselineMedian) / baselineMedian) * 100;
    const line = `${name}: baseline=${baselineMedian.toFixed(0)} ns current=${currentMedian.toFixed(0)} ns change=${relativePercent.toFixed(2)}%`;
    console.log(line);
    if (relativePercent > thresholdPercent) {
      failures.push(line);
    }
  }

  if (failures.length > 0) {
    console.error(
      `benchmark regression: ${failures.length} benchmark(s) exceed ${thresholdPercent}%`,
    );
    process.exitCode = 1;
  }
}

await main();
