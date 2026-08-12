# conc-scoped-threads

> Use `std::thread::scope` to borrow stack data across threads

## Why It Matters

Scoped threads (stable since Rust 1.63) guarantee that all threads spawned inside the scope join before `thread::scope` returns. This lifetime guarantee lets spawned threads borrow non-`'static` data from the enclosing stack frame — no `Arc`, no cloning, no heap allocation required. For short parallel tasks that need to read or write local data, scoped threads are simpler and cheaper than wrapping everything in `Arc<Mutex<...>>`.

## Bad

```rust
use std::sync::{Arc, Mutex};
use std::thread;

fn parallel_sum(data: &[i64]) -> i64 {
    // Arc + clone just to share a slice — heap overhead, boilerplate
    let data = Arc::new(data.to_vec()); // unnecessary clone of entire slice
    let mid = data.len() / 2;

    let data1 = Arc::clone(&data);
    let h1 = thread::spawn(move || data1[..mid].iter().sum::<i64>());

    let data2 = Arc::clone(&data);
    let h2 = thread::spawn(move || data2[mid..].iter().sum::<i64>());

    h1.join().unwrap() + h2.join().unwrap()
}
```

## Good

```rust
use std::thread;

fn parallel_sum(data: &[i64]) -> i64 {
    let mid = data.len() / 2;
    let (left, right) = data.split_at(mid);

    thread::scope(|s| {
        let h1 = s.spawn(|| left.iter().sum::<i64>());
        let h2 = s.spawn(|| right.iter().sum::<i64>());
        h1.join().unwrap() + h2.join().unwrap()
    })
}

// Mutable borrows work too — as long as they don't alias
fn parallel_fill(left: &mut [u8], right: &mut [u8]) {
    thread::scope(|s| {
        s.spawn(|| left.fill(0xAA));
        s.spawn(|| right.fill(0xBB));
    });
    // both halves have been written; scope guarantees completion
}
```

## Key Points

- The closure passed to `thread::scope` receives a `Scope<'env, '_>` handle; threads spawned via `s.spawn(...)` can borrow anything alive in `'env`.
- All threads are joined automatically when the scope returns — even on panic.
- A panicking child thread causes `thread::scope` itself to panic after joining all remaining children.
- For CPU-bound data-parallel work over large collections, prefer rayon's `par_iter()`, which handles chunking and work-stealing automatically.

## When to Use

- Short-lived parallel tasks that share read-only or non-overlapping mutable references to local data
- You need explicit thread control (pinning, priority) that rayon doesn't expose
- Parallelizing a fixed number of distinct sub-tasks (not a homogeneous collection)

## See Also

- [own-arc-shared](own-arc-shared.md) - use `Arc<T>` when data genuinely outlives the parallel task
- [conc-rayon-par-iter](conc-rayon-par-iter.md) - higher-level data parallelism for collections
- [async-spawn-blocking](async-spawn-blocking.md) - offload blocking work from async runtimes
