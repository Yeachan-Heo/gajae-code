# perf-collect-once

> Don't collect intermediate iterators

## Why It Matters

Each `.collect()` allocates a new collection. Chaining multiple operations with intermediate collections wastes memory and CPU cycles. Keep iterator chains lazy and collect only once at the end.

## Bad

```rust
// Three allocations, three passes
fn process_users(users: Vec<User>) -> Vec<String> {
    let active: Vec<_> = users.into_iter()
        .filter(|u| u.is_active)
        .collect();
    
    let verified: Vec<_> = active.into_iter()
        .filter(|u| u.is_verified)
        .collect();
    
    verified.into_iter()
        .map(|u| u.name)
        .collect()
}

// Collecting to count
fn count_valid(items: &[Item]) -> usize {
    items.iter()
        .filter(|i| i.is_valid())
        .collect::<Vec<_>>()  // Unnecessary!
        .len()
}
```

## Good

```rust
// One allocation, one pass
fn process_users(users: Vec<User>) -> Vec<String> {
    users.into_iter()
        .filter(|u| u.is_active)
        .filter(|u| u.is_verified)
        .map(|u| u.name)
        .collect()
}

// No allocation needed
fn count_valid(items: &[Item]) -> usize {
    items.iter()
        .filter(|i| i.is_valid())
        .count()
}
```

## Pattern: Deferred Collection

```rust
// Create the iterator chain
fn prepare_data(raw: Vec<RawData>) -> impl Iterator<Item = ProcessedData> {
    raw.into_iter()
        .filter(|d| d.is_valid())
        .map(ProcessedData::from)
}

// Collect only when needed
let data: Vec<_> = prepare_data(input).collect();

// Or consume without collecting
prepare_data(input).for_each(|d| process(d));
```

## When Intermediate Collection Is Needed

```rust
// Need to iterate multiple times
let items: Vec<_> = data.iter()
    .filter(|x| x.is_valid())
    .collect();

let count = items.len();
let first = items.first();
for item in &items {
    process(item);
}

// Need to sort (requires concrete collection)
let mut sorted: Vec<_> = data.iter()
    .filter(|x| x.is_active)
    .collect();
sorted.sort_by_key(|x| x.priority);
```

## Comparison

| Approach | Allocations | Passes | Memory |
|----------|-------------|--------|--------|
| Multiple `.collect()` | N | N | O(N × data) |
| Single chain + `.collect()` | 1 | 1 | O(data) |
| No `.collect()` (streaming) | 0 | 1 | O(1) |

## Pattern: Collect with Capacity

When you must collect, pre-allocate:

```rust
// With estimated capacity
let mut result = Vec::with_capacity(items.len());
result.extend(
    items.iter()
        .filter(|x| x.is_valid())
        .map(|x| x.clone())
);
```

## See Also

- [perf-iter-lazy](./perf-iter-lazy.md) - Keep iterators lazy
- [mem-with-capacity](./mem-with-capacity.md) - Pre-allocate collections
- [anti-collect-intermediate](./anti-collect-intermediate.md) - Anti-pattern
