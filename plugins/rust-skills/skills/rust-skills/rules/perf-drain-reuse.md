# perf-drain-reuse

> Use drain to reuse allocations

## Why It Matters

`drain()` removes elements from a collection while keeping its allocated capacity. This allows reusing the same allocation across iterations, avoiding repeated allocate/deallocate cycles in loops.

## Bad

```rust
// Allocates new Vec every iteration
fn process_batches(data: Vec<Item>) {
    let mut remaining = data;
    
    while !remaining.is_empty() {
        let batch: Vec<_> = remaining.drain(..100.min(remaining.len())).collect();
        process_batch(batch);
        // remaining keeps its capacity - good
        // but batch allocates new every time - bad
    }
}

// Clears and reallocates
fn reuse_buffer() {
    for _ in 0..1000 {
        let mut buffer = Vec::new();  // Allocates each iteration
        fill_buffer(&mut buffer);
        process(&buffer);
    }
}
```

## Good

```rust
// Reuses allocation with drain
fn process_batches(mut data: Vec<Item>) {
    let mut batch = Vec::with_capacity(100);
    
    while !data.is_empty() {
        batch.extend(data.drain(..100.min(data.len())));
        process_batch(&batch);
        batch.clear();  // Keeps capacity
    }
}

// Reuses buffer across iterations
fn reuse_buffer() {
    let mut buffer = Vec::new();
    
    for _ in 0..1000 {
        buffer.clear();  // Keeps capacity
        fill_buffer(&mut buffer);
        process(&buffer);
    }
}
```

## Drain Methods

| Collection | Method | Behavior |
|------------|--------|----------|
| `Vec<T>` | `.drain(range)` | Remove range, shift remaining |
| `Vec<T>` | `.drain(..)` | Remove all (like clear) |
| `VecDeque<T>` | `.drain(range)` | Remove range |
| `String` | `.drain(range)` | Remove char range |
| `HashMap<K,V>` | `.drain()` | Remove all entries |
| `HashSet<T>` | `.drain()` | Remove all elements |

## Pattern: Batch Processing

```rust
fn process_in_chunks(mut items: Vec<Item>, chunk_size: usize) {
    while !items.is_empty() {
        let chunk: Vec<_> = items.drain(..chunk_size.min(items.len())).collect();
        process_chunk(chunk);
    }
}
```

## Pattern: Transfer Between Collections

```rust
// Move all elements without reallocation
fn transfer_all(src: &mut Vec<Item>, dst: &mut Vec<Item>) {
    dst.extend(src.drain(..));
    // src is now empty but keeps capacity
}

// Move matching elements
fn transfer_matching(src: &mut Vec<Item>, dst: &mut Vec<Item>, predicate: impl Fn(&Item) -> bool) {
    let matching: Vec<_> = src.drain(..).filter(predicate).collect();
    dst.extend(matching);
}
```

## Pattern: HashMap Drain

```rust
use std::collections::HashMap;

fn process_and_clear(map: &mut HashMap<String, Value>) {
    // Process all entries, clearing the map
    for (key, value) in map.drain() {
        process(key, value);
    }
    // map is now empty but keeps capacity
}
```

## drain vs clear vs take

| Operation | Elements | Capacity | Returns |
|-----------|----------|----------|---------|
| `.clear()` | Removed | Kept | Nothing |
| `.drain(..)` | Removed | Kept | Iterator |
| `std::mem::take()` | Moved out | Reset to 0 | Owned collection |

```rust
// clear: just empty
vec.clear();

// drain: empty and iterate
for item in vec.drain(..) {
    process(item);
}

// take: swap with empty, get ownership
let old_vec = std::mem::take(&mut vec);
```

## See Also

- [mem-reuse-collections](./mem-reuse-collections.md) - Reusing collections
- [perf-extend-batch](./perf-extend-batch.md) - Batch insertions
- [mem-with-capacity](./mem-with-capacity.md) - Pre-allocation
