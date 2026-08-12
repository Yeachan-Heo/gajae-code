# mem-clone-from

> Use `clone_from()` to reuse allocations when repeatedly cloning

## Why It Matters

`x = y.clone()` drops x's allocation and creates a new one from y. `x.clone_from(&y)` reuses x's existing allocation if possible, avoiding the allocation overhead. For repeatedly cloning into the same variable (loops, buffers), this can significantly reduce allocator pressure.

## Bad

```rust
let mut buffer = String::with_capacity(1024);

for source in sources {
    buffer = source.clone();  // Drops old allocation, allocates new
    process(&buffer);
}

// Each iteration:
// 1. Drops buffer's 1024-byte allocation
// 2. Allocates new memory for source.clone()
// Allocator thrashing!
```

## Good

```rust
let mut buffer = String::with_capacity(1024);

for source in sources {
    buffer.clone_from(source);  // Reuses allocation if capacity sufficient
    process(&buffer);
}

// If source.len() <= 1024, no allocation happens
// Just copies bytes into existing buffer
```

## How clone_from Works

```rust
impl Clone for String {
    fn clone(&self) -> Self {
        // Always allocates new memory
        String::from(self.as_str())
    }
    
    fn clone_from(&mut self, source: &Self) {
        // Reuse existing capacity if possible
        self.clear();
        self.push_str(source);  // Only reallocates if capacity insufficient
    }
}
```

## Types That Benefit

```rust
// String - reuses capacity
let mut s = String::with_capacity(100);
s.clone_from(&other_string);

// Vec<T> - reuses capacity
let mut v: Vec<u8> = Vec::with_capacity(1000);
v.clone_from(&other_vec);

// HashMap - reuses buckets
let mut map = HashMap::with_capacity(100);
map.clone_from(&other_map);

// PathBuf - reuses capacity
let mut path = PathBuf::with_capacity(256);
path.clone_from(&other_path);
```

## Benchmarking the Difference

```rust
use criterion::{black_box, criterion_group, Criterion};

fn bench_clone_patterns(c: &mut Criterion) {
    let source = "x".repeat(1000);
    
    c.bench_function("clone assignment", |b| {
        let mut buffer = String::new();
        b.iter(|| {
            buffer = black_box(&source).clone();
        });
    });
    
    c.bench_function("clone_from", |b| {
        let mut buffer = String::with_capacity(1000);
        b.iter(|| {
            buffer.clone_from(black_box(&source));
        });
    });
}
// clone_from is typically 2-3x faster for this pattern
```

## Custom Implementations

When implementing Clone for your types:

```rust
#[derive(Debug)]
struct Buffer {
    data: Vec<u8>,
    metadata: Metadata,
}

impl Clone for Buffer {
    fn clone(&self) -> Self {
        Buffer {
            data: self.data.clone(),
            metadata: self.metadata.clone(),
        }
    }
    
    // Optimize clone_from to reuse vec capacity
    fn clone_from(&mut self, source: &Self) {
        self.data.clone_from(&source.data);  // Reuses allocation
        self.metadata = source.metadata.clone();
    }
}
```

## When NOT Needed

```rust
// Single clone - no benefit
let copy = original.clone();  // Can't reuse, no prior allocation

// Small Copy types - no allocation anyway
let x: i32 = y;  // Not even Clone, just Copy

// Immutable context
fn process(data: &String) {
    // Can't use clone_from - would need &mut self
}
```

## See Also

- [mem-with-capacity](./mem-with-capacity.md) - Pre-allocating capacity
- [mem-reuse-collections](./mem-reuse-collections.md) - Reusing collection allocations
- [own-clone-explicit](./own-clone-explicit.md) - When Clone is appropriate
