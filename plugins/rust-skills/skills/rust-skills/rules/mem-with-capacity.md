# mem-with-capacity

> Use `with_capacity()` when size is known

## Why It Matters

When you know (or can estimate) the final size of a collection, pre-allocating avoids multiple reallocations as it grows. Each reallocation copies all existing elements, so avoiding them can dramatically improve performance.

## Bad

```rust
// Vec starts at capacity 0, reallocates at 4, 8, 16, 32...
let mut results = Vec::new();
for i in 0..1000 {
    results.push(process(i));  // ~10 reallocations!
}

// String grows similarly
let mut output = String::new();
for word in words {
    output.push_str(word);
    output.push(' ');
}

// HashMap default capacity is small
let mut map = HashMap::new();
for (k, v) in pairs {  // Many reallocations
    map.insert(k, v);
}
```

## Good

```rust
// Pre-allocate exact size
let mut results = Vec::with_capacity(1000);
for i in 0..1000 {
    results.push(process(i));  // Zero reallocations!
}

// Or use collect with size hint (iterator provides capacity)
let results: Vec<_> = (0..1000).map(process).collect();

// Pre-allocate string
let estimated_len = words.iter().map(|w| w.len() + 1).sum();
let mut output = String::with_capacity(estimated_len);
for word in words {
    output.push_str(word);
    output.push(' ');
}

// Pre-allocate HashMap
let mut map = HashMap::with_capacity(pairs.len());
for (k, v) in pairs {
    map.insert(k, v);
}
```

## Collection Capacity Methods

```rust
// Vec
let mut v = Vec::with_capacity(100);
v.reserve(50);        // Ensure at least 50 more slots
v.reserve_exact(50);  // Ensure exactly 50 more (no extra)
v.shrink_to_fit();    // Release unused capacity

// String
let mut s = String::with_capacity(100);
s.reserve(50);

// HashMap / HashSet
let mut m = HashMap::with_capacity(100);
m.reserve(50);

// VecDeque
let mut d = VecDeque::with_capacity(100);
```

## Estimating Capacity

```rust
// From iterator length
fn collect_results(items: &[Item]) -> Vec<Output> {
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        results.push(process(item));
    }
    results
}

// From filter estimate (if ~10% pass filter)
fn filter_valid(items: &[Item]) -> Vec<&Item> {
    let mut valid = Vec::with_capacity(items.len() / 10);
    for item in items {
        if item.is_valid() {
            valid.push(item);
        }
    }
    valid
}

// String from parts
fn join_with_sep(parts: &[&str], sep: &str) -> String {
    let total_len: usize = parts.iter().map(|p| p.len()).sum();
    let sep_len = if parts.is_empty() { 0 } else { sep.len() * (parts.len() - 1) };
    
    let mut result = String::with_capacity(total_len + sep_len);
    for (i, part) in parts.iter().enumerate() {
        if i > 0 {
            result.push_str(sep);
        }
        result.push_str(part);
    }
    result
}
```

## Evidence from Production Code

From fd (file finder):
```rust
// https://github.com/sharkdp/fd/blob/master/src/walk.rs
struct ReceiverBuffer<'a, W> {
    buffer: Vec<DirEntry>,
    // ...
}

impl<'a, W: Write> ReceiverBuffer<'a, W> {
    fn new(...) -> Self {
        Self {
            buffer: Vec::with_capacity(MAX_BUFFER_LENGTH),
            // ...
        }
    }
}
```

## When to Skip

```rust
// Unknown size, small expected
let mut small: Vec<i32> = Vec::new();  // OK for small collections

// Using collect() with good size_hint
let v: Vec<_> = iter.collect();  // collect() uses size_hint

// Capacity overhead exceeds benefit
let mut rarely_used = Vec::new();  // OK if rarely grown
```

## See Also

- [mem-reuse-collections](mem-reuse-collections.md) - Reuse collections with clear()
- [mem-smallvec](mem-smallvec.md) - Use SmallVec for usually-small collections
- [perf-extend-batch](perf-extend-batch.md) - Use extend() for batch insertions
- [coll-seq-choice](coll-seq-choice.md) - Pick the right sequence type
