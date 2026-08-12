# coll-map-choice

> Pick the map by access pattern: `HashMap` (fast, unordered), `BTreeMap` (sorted / range queries), `IndexMap` (insertion order)

## Why It Matters

`HashMap` is the right default: O(1) average lookup and insertion with no ordering overhead. `BTreeMap` keeps keys sorted in a B-tree, enabling efficient range queries and ordered iteration at the cost of O(log n) operations. The `indexmap` crate's `IndexMap` preserves insertion order with O(1) average lookup — valuable for deterministic output, config files, or any API where output order must match input order. Choosing the wrong map wastes CPU cycles on sorting you don't need or forces you to sort after the fact.

## Bad

```rust
use std::collections::HashMap;

fn word_counts(text: &str) -> HashMap<&str, usize> {
    let mut counts = HashMap::new();
    for word in text.split_whitespace() {
        *counts.entry(word).or_insert(0) += 1;
    }
    counts
    // Iterating this for a report produces random order every run.
    // Caller has to sort externally — meaning repeated, avoidable work.
}

fn main() {
    let counts = word_counts("the quick brown fox jumps over the lazy dog");
    // Non-deterministic output: order changes between runs.
    for (word, count) in &counts {
        println!("{word}: {count}");
    }
}
```

## Good

```rust
// --- 1. HashMap: default, fast, unordered ---
use std::collections::HashMap;

fn total_scores<'a>(records: &[(&'a str, u32)]) -> HashMap<&'a str, u32> {
    let mut scores: HashMap<&'a str, u32> = HashMap::new();
    for &(name, score) in records {
        *scores.entry(name).or_insert(0) += score;
    }
    scores
}

// --- 2. BTreeMap: sorted keys, range queries ---
use std::collections::BTreeMap;

fn events_in_range(
    log: &BTreeMap<u64, String>,
    start: u64,
    end: u64,
) -> Vec<(&u64, &String)> {
    // range() is only possible because BTreeMap keeps keys sorted.
    log.range(start..=end).collect()
}

fn build_log() -> BTreeMap<u64, String> {
    let mut log = BTreeMap::new();
    log.insert(1_000, "server started".to_string());
    log.insert(2_000, "request received".to_string());
    log.insert(3_000, "response sent".to_string());
    log
}

// --- 3. IndexMap: insertion order + O(1) lookup ---
use indexmap::IndexMap;

fn parse_config(pairs: &[(&str, &str)]) -> IndexMap<String, String> {
    // Keys iterated in the order they were inserted — deterministic output.
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn main() {
    // BTreeMap range query
    let log = build_log();
    let window = events_in_range(&log, 1_000, 2_500);
    for (ts, msg) in window {
        println!("{ts}: {msg}");
    }

    // IndexMap preserves insertion order
    let cfg = parse_config(&[("host", "localhost"), ("port", "8080"), ("debug", "true")]);
    for (k, v) in &cfg {
        println!("{k} = {v}"); // always: host, port, debug
    }
}
```

## Which to Use

| Requirement | Choose |
|---|---|
| Fast lookup, order irrelevant | `HashMap` |
| Sorted iteration or range queries | `BTreeMap` |
| Insertion-order iteration + fast lookup | `IndexMap` (indexmap crate) |
| Tiny map (≤ 8 entries), no heap | consider an array of tuples |

**Note on hashing:** The default `HashMap` uses SipHash-1-3, which is DOS-resistant but not the fastest. For non-adversarial hot paths, see `perf-ahash` for a faster hasher that drops in as a type parameter.

## See Also

- [perf-ahash](perf-ahash.md) - swap in a faster hasher for non-adversarial maps
- [perf-entry-api](perf-entry-api.md) - use `entry()` to avoid double lookups
- [coll-seq-choice](coll-seq-choice.md) - choosing the right sequence type
