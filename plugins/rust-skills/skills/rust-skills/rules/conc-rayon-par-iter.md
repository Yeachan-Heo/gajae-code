# conc-rayon-par-iter

> Use rayon's `par_iter()` for CPU-bound data parallelism

## Why It Matters

Rayon's work-stealing scheduler parallelizes data-parallel workloads with an API nearly identical to standard iterators — often a one-word change from `.iter()` to `.par_iter()` yields near-linear speedup across cores. It automatically balances load across threads, handles chunking, and composes with the full iterator adapter chain. For IO-bound concurrency, use async instead; rayon is strictly for CPU-bound computation.

## Bad

```rust
// single-threaded — wastes available cores on a CPU-bound workload
fn sum_squares(data: &[f64]) -> f64 {
    data.iter().map(|x| x * x).sum()
}

fn normalize(data: &mut [f64]) {
    let max = data.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    data.iter_mut().for_each(|x| *x /= max);
}
```

## Good

```rust
use rayon::prelude::*;

fn sum_squares(data: &[f64]) -> f64 {
    data.par_iter().map(|x| x * x).sum()
}

fn normalize(data: &mut [f64]) {
    let max = data.par_iter().cloned().reduce(|| f64::NEG_INFINITY, f64::max);
    data.par_iter_mut().for_each(|x| *x /= max);
}

fn keep_positive(data: &[f64]) -> Vec<f64> {
    data.par_iter().copied().filter(|&x| x > 0.0).collect()
}

fn sort_large(data: &mut [f64]) {
    // parallel unstable sort — faster than std sort for large slices
    data.par_sort_unstable_by(|a, b| a.partial_cmp(b).unwrap());
}
```

## Key Points

| Concern | Guidance |
|---------|----------|
| Import | `use rayon::prelude::*;` enables `.par_iter()` on slices and most collections |
| IO-bound work | Use async (`tokio`, `async-std`), not rayon — rayon threads block |
| Small collections | Sequential is often faster due to thread-spawn overhead; profile first |
| Minimum chunk size | Rayon's `with_min_len()` / `with_max_len()` tune granularity |
| Shared state | Use `Mutex` or atomic operations; rayon does not prevent data races |

## When to Use

- Processing large arrays, slices, or collections (image pixels, number crunching, parsing batches)
- CPU-bound transformations: map, filter, fold, sort
- When the per-element work is non-trivial (at least a few hundred nanoseconds)

## See Also

- [conc-scoped-threads](conc-scoped-threads.md) - borrow stack data across short-lived threads
- [perf-iter-over-index](perf-iter-over-index.md) - prefer iterators over manual indexing
- [async-spawn-blocking](async-spawn-blocking.md) - offload CPU work from async runtimes
