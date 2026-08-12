# anti-premature-optimize

> Don't optimize before profiling

## Why It Matters

Premature optimization wastes time, complicates code, and often targets the wrong bottlenecks. Most code isn't performance-critical; the hot 10% matters. Profile first, then optimize the actual bottlenecks with data-driven decisions.

## Bad

```rust
// "Optimizing" without measurement
fn sum(data: &[i32]) -> i32 {
    // Using unsafe "for performance" without profiling
    unsafe {
        let mut sum = 0;
        for i in 0..data.len() {
            sum += *data.get_unchecked(i);
        }
        sum
    }
}

// Complex caching with no evidence it's needed
lazy_static! {
    static ref CACHE: RwLock<HashMap<String, Arc<Result>>> = 
        RwLock::new(HashMap::new());
}

// Hand-rolled data structures "for speed"
struct MyVec<T> {
    ptr: *mut T,
    len: usize,
    cap: usize,
}
```

## Good

```rust
// Simple, idiomatic - let compiler optimize
fn sum(data: &[i32]) -> i32 {
    data.iter().sum()
}

// Profile, then optimize if needed
fn sum_optimized(data: &[i32]) -> i32 {
    // After profiling showed this is a bottleneck,
    // we measured that manual SIMD gives 3x speedup
    #[cfg(target_arch = "x86_64")]
    {
        // a hand-written SIMD path would go here (measured ~3x faster);
        // fall back to the iterator version as a placeholder
        data.iter().sum()
    }
    #[cfg(not(target_arch = "x86_64"))]
    {
        data.iter().sum()
    }
}

// Use standard library - it's well-optimized
let cache: HashMap<String, Result> = HashMap::new();
```

## Profiling Workflow

```bash
# 1. Write correct code first
cargo build --release

# 2. Profile with real workloads
cargo flamegraph --bin my_app -- --real-args
# or
cargo bench

# 3. Identify hotspots (top 10% of time)

# 4. Measure before optimizing
# 5. Optimize ONE thing
# 6. Measure after - verify improvement
# 7. Repeat if still slow
```

## Optimization Principles

| Do | Don't |
|----|-------|
| Profile first | Guess at bottlenecks |
| Optimize hotspots | Optimize everything |
| Measure improvement | Assume it's faster |
| Keep it simple | Add complexity speculatively |
| Trust the compiler | Outsmart the compiler |

## When to Optimize

```rust
// AFTER profiling shows this is 40% of runtime
#[inline]
fn hot_function(data: &[u8]) -> u64 {
    // Optimized implementation justified by benchmarks
}

// Clear, measurable benefit documented
/// Pre-allocated buffer for repeated formatting.
/// Benchmarks show 3x speedup for >1000 calls/sec workloads.
struct FormatterPool {
    buffers: Vec<String>,
}
```

## Common Premature Optimizations

| Premature | Reality |
|-----------|---------|
| `#[inline(always)]` everywhere | Compiler usually knows better |
| `unsafe` for bounds check removal | Iterator does this safely |
| Custom allocator | Default is usually fine |
| Object pooling | Allocator is fast enough |
| Manual SIMD | Auto-vectorization works |

## Profile Tools

```bash
# Sampling profiler
perf record ./target/release/app && perf report

# Flamegraph
cargo install flamegraph
cargo flamegraph

# Criterion benchmarks
cargo bench

# Memory profiling
valgrind --tool=massif ./target/release/app
```

## Document Optimizations

```rust
/// Lookup table for fast character classification.
/// 
/// # Performance
/// 
/// Benchmarked with criterion (benchmarks/char_class.rs):
/// - Table lookup: 2.3ns/op
/// - Match statement: 8.7ns/op
/// 
/// Justified for hot path in parser (called 10M+ times).
static CHAR_CLASS: [CharClass; 256] = [/* ... */];
```

## See Also

- [perf-profile-first](./perf-profile-first.md) - Profile before optimize
- [test-criterion-bench](./test-criterion-bench.md) - Benchmarking
- [opt-inline-small](./opt-inline-small.md) - Inline guidelines
