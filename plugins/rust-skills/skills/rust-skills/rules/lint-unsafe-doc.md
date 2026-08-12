# lint-unsafe-doc

> Require documentation for unsafe blocks

## Why It Matters

The `undocumented_unsafe_blocks` lint ensures every unsafe block has a `// SAFETY:` comment explaining why the operation is sound. Unsafe code is the source of most memory safety bugs—documenting invariants catches mistakes and helps reviewers.

## Configuration

```rust
#![warn(clippy::undocumented_unsafe_blocks)]
```

Or in `Cargo.toml`:

```toml
[lints.clippy]
undocumented_unsafe_blocks = "warn"
```

For strict enforcement:

```toml
[lints.clippy]
undocumented_unsafe_blocks = "deny"
```

## Bad

```rust
pub fn read_data(ptr: *const u8, len: usize) -> &[u8] {
    unsafe {
        std::slice::from_raw_parts(ptr, len)  // WARN: undocumented
    }
}

impl Buffer {
    pub fn get_unchecked(&self, index: usize) -> &u8 {
        unsafe { self.data.get_unchecked(index) }  // WARN
    }
}
```

## Good

```rust
pub fn read_data(ptr: *const u8, len: usize) -> &[u8] {
    // SAFETY: Caller guarantees:
    // - ptr is valid for reads of len bytes
    // - ptr is properly aligned for u8
    // - the memory is initialized
    // - no mutable references exist to this memory
    unsafe {
        std::slice::from_raw_parts(ptr, len)
    }
}

impl Buffer {
    pub fn get_unchecked(&self, index: usize) -> &u8 {
        debug_assert!(index < self.len(), "index out of bounds");
        // SAFETY: We verified index < len in debug builds.
        // Callers must ensure index is within bounds.
        unsafe { self.data.get_unchecked(index) }
    }
}
```

## SAFETY Comment Format

```rust
// SAFETY: <explanation of why this is sound>
unsafe {
    // ...
}
```

The comment should explain:
1. **What invariants are upheld** - preconditions that make this safe
2. **Why the invariants hold** - how you know they're satisfied
3. **What could go wrong** - if invariants are violated

## Examples by Category

### Pointer Operations

```rust
// SAFETY: ptr was obtained from Box::into_raw, so it's valid
// and properly aligned. We're taking back ownership.
let boxed = unsafe { Box::from_raw(ptr) };
```

### Unchecked Operations

```rust
// SAFETY: We just checked that i < self.len() above.
// The bounds check cannot be elided by the optimizer
// because len() is not inlined.
unsafe { self.data.get_unchecked(i) }
```

### FFI Calls

```rust
// SAFETY: libc::getenv is safe to call with a null-terminated
// string. We ensure null termination with CString::new.
// The returned pointer is valid for the lifetime of the environment.
let value = unsafe { libc::getenv(key.as_ptr()) };
```

### Trait Implementations

```rust
// SAFETY: MyType contains no pointers or interior mutability,
// and all bit patterns are valid MyType values.
unsafe impl Send for MyType {}
unsafe impl Sync for MyType {}
```

## Related Lints

```toml
[lints.clippy]
undocumented_unsafe_blocks = "warn"
# Also consider:
multiple_unsafe_ops_per_block = "warn"  # One operation per block
```

## See Also

- [doc-safety-section](./doc-safety-section.md) - `# Safety` in docs
- [lint-deny-correctness](./lint-deny-correctness.md) - Correctness lints
- [type-repr-transparent](./type-repr-transparent.md) - FFI safety
