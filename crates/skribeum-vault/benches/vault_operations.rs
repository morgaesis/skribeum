use std::hint::black_box;
use std::path::PathBuf;
use std::time::Duration;

use criterion::{BatchSize, Criterion, Throughput, criterion_group, criterion_main};
use skribeum_vault::{Reconciler, ReconcilerConfig, SearchIndex, SimFs, VaultPath, classify};

const NOTE: &[u8] = br"---
title: Benchmark note
---

# Indexable heading

The index benchmark exercises title, heading, body, links, tags, and repeated
words in a deterministic note with enough content to cross the parser path.

[[Related note]] #benchmark #search
";

const UPDATED_NOTE: &[u8] = br"---
title: Updated benchmark note
---

# Changed heading

The reconciler benchmark observes an external update with a changed body and
the same stable file path.
";

fn reconcile_config() -> ReconcilerConfig {
    ReconcilerConfig {
        settle: Duration::from_millis(1),
        write_settle: Duration::from_millis(10),
        shrink_guard_percent: 25,
        bulk_threshold: 20,
    }
}

fn reconcile_fixture() -> (SimFs, Reconciler, PathBuf) {
    let fs = SimFs::new();
    let root = PathBuf::from("benchmark-vault");
    let absolute = root.join("note.md");
    let path = VaultPath::new("note.md").expect("fixture path is valid");

    fs.external_create_dir(&root);
    fs.external_write(&absolute, NOTE);
    fs.deliver_all();

    let mut reconciler = Reconciler::new(reconcile_config());
    reconciler.record_read(&path, NOTE);
    fs.external_write(&absolute, UPDATED_NOTE);
    fs.advance_ticks(1);
    reconciler.observe_event(&path, Duration::from_millis(fs.tick()));

    (fs, reconciler, root)
}

fn bench_vault_operations(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("vault");
    group.throughput(Throughput::Bytes(NOTE.len() as u64));

    let index = SearchIndex::in_memory().expect("in-memory index opens");
    group.bench_function("index", |bencher| {
        bencher.iter(|| {
            index
                .index_note("folder/benchmark.md", black_box(NOTE))
                .expect("fixture indexes");
        });
    });

    group.bench_function("hash", |bencher| {
        bencher.iter(|| {
            let content = classify(black_box(NOTE.to_vec()));
            black_box(content);
        });
    });

    group.bench_function("reconcile", |bencher| {
        bencher.iter_batched(
            reconcile_fixture,
            |(fs, mut reconciler, root)| {
                fs.advance_ticks(2);
                let events = reconciler.poll(&fs, &root, Duration::from_millis(fs.tick()));
                black_box(events);
            },
            BatchSize::SmallInput,
        );
    });

    group.finish();
}

criterion_group!(benches, bench_vault_operations);
criterion_main!(benches);
