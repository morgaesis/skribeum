use criterion::{Criterion, Throughput, criterion_group, criterion_main};
use pulldown_cmark::{Event, Options, Parser};
use skribeum_core::extract;
use std::hint::black_box;

const MARKDOWN: &[u8] = br"---
title: Benchmark note
tags: [bench, markdown]
---

# Parsing and extraction

This note has **emphasis**, `inline code`, a [link](https://example.com),
an [[internal link|display name]], an ![[embedded note]], and #benchmark.

> A callout-like block with a ^block-id.

```rust
fn example() -> usize {
    42
}
```

- [ ] A task item
- A table follows

| Name | Value |
| --- | --- |
| alpha | one |
| beta | two |
";

fn parser_options() -> Options {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_WIKILINKS);
    options
}

fn bench_parse_and_extract(criterion: &mut Criterion) {
    let mut group = criterion.benchmark_group("parse_extract");
    group.throughput(Throughput::Bytes(MARKDOWN.len() as u64));

    group.bench_function("parse", |bencher| {
        bencher.iter(|| {
            let source = core::str::from_utf8(black_box(MARKDOWN)).expect("fixture is UTF-8");
            let events: Vec<Event<'_>> = Parser::new_ext(source, parser_options()).collect();
            black_box(events);
        });
    });

    group.bench_function("extract", |bencher| {
        bencher.iter(|| {
            let extractions = extract(black_box(MARKDOWN));
            black_box(extractions);
        });
    });

    group.finish();
}

criterion_group!(benches, bench_parse_and_extract);
criterion_main!(benches);
