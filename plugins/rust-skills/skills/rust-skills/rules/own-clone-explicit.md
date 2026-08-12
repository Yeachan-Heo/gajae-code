# own-clone-explicit

> Use explicit `Clone` for types where copying has meaningful cost

## Why It Matters

Unlike `Copy` which is implicit and "free," `Clone` requires an explicit `.clone()` call, signaling that duplication has a cost. This makes heap allocations and deep copies visible in code, helping developers reason about performance. Types with heap data (`String`, `Vec`, `Box`) should implement `Clone` but not `Copy`.

## Bad

```rust
// Hiding expensive operations
fn process_data(data: Vec<u32>) -> Vec<u32> {
    let backup = data; // Moved, not copied - but unclear at call site
    transform(backup)
}

let my_data = vec![1, 2, 3, 4, 5];
let result = process_data(my_data);
// my_data is moved - surprise if you expected it to still exist
```

## Good

```rust
fn process_data(data: Vec<u32>) -> Vec<u32> {
    let backup = data; 
    transform(backup)
}

let my_data = vec![1, 2, 3, 4, 5];
let result = process_data(my_data.clone()); // Explicit: "I know this allocates"
// my_data still available

// Or better - take reference if you don't need ownership
fn process_data_ref(data: &[u32]) -> Vec<u32> {
    transform(data)
}
let result = process_data_ref(&my_data); // No clone needed
```

## Custom Clone Implementation

For types with mixed cheap/expensive fields, implement `Clone` manually:

```rust
#[derive(Debug)]
struct Document {
    id: u64,              // Cheap to copy
    content: String,      // Expensive to clone
    metadata: Metadata,   // Moderate cost
}

impl Clone for Document {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            content: self.content.clone(),
            metadata: self.metadata.clone(),
        }
    }
    
    // Optimization: reuse existing allocations
    fn clone_from(&mut self, source: &Self) {
        self.id = source.id;
        self.content.clone_from(&source.content); // Reuses capacity
        self.metadata.clone_from(&source.metadata);
    }
}
```

## clone_from Optimization

`clone_from` can reuse existing allocations:

```rust
let mut buffer = String::with_capacity(1000);

// Bad: drops old allocation, creates new one
buffer = source.clone();

// Good: reuses existing capacity if sufficient
buffer.clone_from(&source);
```

## Derive vs Manual Clone

```rust
// Derive when all fields need cloning
#[derive(Clone)]
struct Simple {
    data: Vec<u8>,
    name: String,
}

// Manual when you need special behavior
struct CachedValue {
    value: i32,
    cache: RefCell<Option<ExpensiveComputation>>,
}

impl Clone for CachedValue {
    fn clone(&self) -> Self {
        Self {
            value: self.value,
            cache: RefCell::new(None), // Don't clone cache, let it rebuild
        }
    }
}
```

## When to Avoid Clone

```rust
// Instead of cloning, consider:

// 1. References
fn process(data: &MyType) { } // Borrow instead of clone

// 2. Cow for conditional cloning
fn process(data: Cow<'_, str>) { } // Clone only if mutation needed

// 3. Arc for shared ownership
let shared = Arc::new(expensive_data);
let handle = shared.clone(); // Cheap: just increments counter

// 4. Passing by value when caller is done with it
fn consume(data: MyType) { } // Caller moves, no clone
```

## See Also

- [own-copy-small](./own-copy-small.md) - When implicit Copy is appropriate
- [own-cow-conditional](./own-cow-conditional.md) - Avoiding clones with Cow
- [mem-clone-from](./mem-clone-from.md) - Optimizing repeated clones
