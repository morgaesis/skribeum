# Performance reference

## Reference machine

Absolute measurements use an 8-vCPU, Haswell-class virtual machine with 32 GiB of memory and Ubuntu 24.04 LTS. CI enforces relative Rust benchmark regressions only. Absolute interaction budgets are reference-machine assertions for tag validation.

## Keystroke latency

`scripts/keystroke-latency.ts` creates a real CodeMirror `EditorView` under jsdom, performs 1,000 warmup events, then records 10,000 deterministic editor updates. Four out of every five events insert one character and the fifth performs a selection drag. The update listener measures dispatch start through the corresponding editor update.

The 100,000-line corpus contains 6,599,898 characters with no blank lines, so Markdown treats it as one paragraph block. In the unbounded profile, the no-language baseline is about 2 ms per update, plain CommonMark is about 930 ms, and the GFM plus Obsidian chain is about 2.2 s. CPU sampling attributes 59% self time and 84% total time to Lezer inline parsing, with Markdown block advancement accounting for 84.4% total time; removing the frontmatter extension does not materially change the result.

Lezer reuses incremental fragments at block boundaries, and the corpus provides no reusable boundary inside its single 6.6 MB paragraph. The editor Markdown extension therefore ends paragraph leaves at 4,096 characters, bounds frontmatter and math block lookahead at 16,384 characters, and lets CodeMirror reuse all unaffected blocks after an edit. The outline reads only the syntax tree CodeMirror already maintains and refreshes during idle work, so it does not force parsing to the document end on the input path.

### 100,000-line corpus

| Configuration | p50 | p95 | p99 | Edit p99 | Selection p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No language | 1.52 ms | 3.22 ms | 8.02 ms | 7.89 ms | 8.42 ms | 13.82 ms |
| Markdown language | 2.81 ms | 4.43 ms | 9.50 ms | 9.67 ms | 8.13 ms | 19.86 ms |
| Markdown and decorations | 3.00 ms | 4.44 ms | 9.90 ms | 10.00 ms | 8.89 ms | 21.15 ms |

The full extension chain satisfies the p99 budget of less than 16 ms.

### Two-megabyte single line

Lines longer than 10,000 characters use the existing long-line syntax policy. Markdown parsing, syntax highlighting, editor decorations, and bracket matching are absent while text editing, selection, line wrapping, and history remain active. `tests/web/syntaxPolicy.test.ts` checks the policy and the disabled services directly.

| Configuration | p50 | p95 | p99 | Edit p99 | Selection p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| No language | 3.09 ms | 5.48 ms | 11.50 ms | 11.89 ms | 8.04 ms | 49.15 ms |
| Markdown policy | 1.95 ms | 4.53 ms | 9.48 ms | 9.76 ms | 7.68 ms | 36.70 ms |
| Full editor policy | 2.07 ms | 5.58 ms | 10.87 ms | 11.20 ms | 7.75 ms | 49.00 ms |

The full editor policy satisfies the p99 budget of less than 16 ms.

## Rust benchmark regression gate

Criterion benchmarks cover Markdown parsing, extraction, search indexing, content hashing, and reconciliation. The committed JSON files under each crate's `benches/baselines/` retain five measurements for the Linux x64 runner class. The Linux leg of the existing Rust CI job compares the current Criterion median with the committed rolling median and fails when a benchmark is more than 10% slower.

| Benchmark | Baseline median | Reference run | Relative change |
| --- | ---: | ---: | ---: |
| Parse | 7,844 ns | 7,952 ns | +1.37% |
| Extract | 6,874 ns | 7,028 ns | +2.24% |
| Hash | 3,163 ns | 3,134 ns | -0.92% |
| Index | 73,716 ns | 72,072 ns | -2.23% |
| Reconcile | 5,242 ns | 4,789 ns | -8.63% |

The comparator returns zero for an unchanged baseline and returns one for an artificial 24.94% parse regression and 30.93% extraction regression.

Refresh a baseline only from an unloaded runner in the documented reference class:

```sh
cargo bench -p skribeum-core --bench parse_extract --locked -- --noplot
cargo bench -p skribeum-vault --bench vault_operations --locked -- --noplot
bun scripts/compare-benchmarks.ts \
  --baseline crates/skribeum-core/benches/baselines/core.json \
  --criterion-dir target/criterion \
  --refresh-baseline
bun scripts/compare-benchmarks.ts \
  --baseline crates/skribeum-vault/benches/baselines/vault.json \
  --criterion-dir target/criterion \
  --refresh-baseline
```

Each refresh appends the current median and retains the trailing five samples.

## Cold start

The debug-only instrumentation calibrates the Rust process clock at main entry against the webview clock at page load. After the editor's second animation frame, the webview reports the calibrated process timestamp over a debug event. `scripts/cold-start.ts` launches the built debug binary headlessly with Xvfb and a window manager for 20 independent process starts.

The 20-run first-editor-paint sample is:

```text
31385, 31572, 31495, 11015, 31419, 31492, 31524, 20641, 31546, 31531,
31451, 21883, 31482, 31498, 31763, 11794, 31996, 31772, 31658, 18404 ms
```

The p50 is 31,492 ms and the p95 is 31,772 ms. The first run uses a deterministic 5,000-note temporary vault: first paint occurs at 31,385 ms, full-text indexing completes at 44,522 ms, and the 13,137 ms ordering gap proves indexing is off the first-paint critical path.

## Search at scale

`scripts/search-scale.ts` generates and indexes 5,000 deterministic notes with seed `0x51ca1e5ed00df00d`. The index rebuild takes 4,206.67 ms and reports all 5,000 notes indexed.

The Rust scale test samples one broad query and six deterministic group-and-topic queries. For every query, the FTS result set equals an independent brute-force token scan, and the rebuild performs no writes inside the vault.

## In-app note open

`scripts/editor-scale.ts` drives the built debug binary through its embedded WebDriver endpoint and measures the application timer around `note_read`, state assignment, and the Svelte editor swap. A 20-run, approximately 10 KiB note sample has p50 29 ms and p95 47 ms; the samples after the initial warm application call range from 22 ms to 47 ms.

`note_read` does not perform synchronous FTS indexing. Background rebuilds, saves, and watcher reconciliation maintain the search index without extending the note-open critical path. This reference covers the in-app note-open path; OS file-manager entry belongs to the M4 packaging criterion.

## Memory growth

The memory mode of `scripts/keystroke-latency.ts` launches the real debug binary, opens the 100,000-line corpus, and samples aggregate resident memory for the application and its WebKit process tree. It applies four deterministic batches of 10,000 editor events.

| Applied events | RSS |
| ---: | ---: |
| 0 | 949.92 MiB |
| 10,000 | 1,055.12 MiB |
| 20,000 | 1,062.25 MiB |
| 30,000 | 1,081.81 MiB |
| 40,000 | 1,032.78 MiB |

The final two-batch growth is -29.46 MiB. The curve drops below its 20,000-event sample by the end of the run, satisfying the flattening assertion.
