# anti-collect-intermediate

> Don't collect intermediate iterators

## Why It Matters

Each `.collect()` allocates a new collection. Collecting intermediate results in a chain creates unnecessary allocations and prevents iterator fusion. Keep the chain lazy; collect only at the end.

## Bad

```rust
// Three allocations, three passes
fn process(data: Vec<i32>) -> Vec<i32> {
    let step1: Vec<_> = data.into_iter()
        .filter(|x| *x > 0)
        .collect();
    
    let step2: Vec<_> = step1.into_iter()
        .map(|x| x * 2)
        .collect();
    
    step2.into_iter()
        .filter(|x| *x < 100)
        .collect()
}

// Collecting just to check length
fn has_valid_items(items: &[Item]) -> bool {
    let valid: Vec<_> = items.iter()
        .filter(|i| i.is_valid())
        .collect();
    !valid.is_empty()
}

// Collecting to iterate again
fn sum_valid(items: &[Item]) -> i64 {
    let valid: Vec<_> = items.iter()
        .filter(|i| i.is_valid())
        .collect();
    valid.iter().map(|i| i.value).sum()
}
```

## Good

```rust
// Single allocation, single pass
fn process(data: Vec<i32>) -> Vec<i32> {
    data.into_iter()
        .filter(|x| *x > 0)
        .map(|x| x * 2)
        .filter(|x| *x < 100)
        .collect()
}

// No allocation - iterator short-circuits
fn has_valid_items(items: &[Item]) -> bool {
    items.iter().any(|i| i.is_valid())
}

// No intermediate allocation
fn sum_valid(items: &[Item]) -> i64 {
    items.iter()
        .filter(|i| i.is_valid())
        .map(|i| i.value)
        .sum()
}
```

## When Collection Is Needed

```rust
// Need to iterate twice
let valid: Vec<_> = items.iter()
    .filter(|i| i.is_valid())
    .collect();
let count = valid.len();
for item in &valid {
    process(item);
}

// Need to sort (requires concrete collection)
let mut sorted: Vec<_> = items.iter()
    .filter(|i| i.is_active())
    .collect();
sorted.sort_by_key(|i| i.priority);

// Need random access
let indexed: Vec<_> = items.iter().collect();
let middle = indexed.get(indexed.len() / 2);
```

## Iterator Methods That Avoid Collection

| Instead of Collecting to... | Use |
|-----------------------------|-----|
| Check if empty | `.any(|_| true)` or `.next().is_some()` |
| Check if any match | `.any(predicate)` |
| Check if all match | `.all(predicate)` |
| Count elements | `.count()` |
| Sum elements | `.sum()` |
| Find first | `.find(predicate)` |
| Get first | `.next()` |
| Get last | `.last()` |

## Pattern: Deferred Collection

```rust
// Return iterator, let caller collect if needed
fn valid_items(items: &[Item]) -> impl Iterator<Item = &Item> {
    items.iter().filter(|i| i.is_valid())
}

// Caller decides
let count = valid_items(&items).count();  // No collection
let vec: Vec<_> = valid_items(&items).collect();  // Collection when needed
```

## Comparison

| Pattern | Allocations | Passes |
|---------|-------------|--------|
| `.collect()` each step | N | N |
| Single chain, one `.collect()` | 1 | 1 |
| No collection (streaming) | 0 | 1 |

## See Also

- [perf-collect-once](./perf-collect-once.md) - Single collect
- [perf-iter-lazy](./perf-iter-lazy.md) - Lazy evaluation
- [perf-iter-over-index](./perf-iter-over-index.md) - Iterator patterns
