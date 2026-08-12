# doc-safety-section

> Include `# Safety` section for unsafe functions

## Why It Matters

Unsafe functions require callers to uphold invariants that the compiler cannot verify. The `# Safety` section documents exactly what the caller must guarantee for the function to be sound. Without this, users cannot safely call the function.

This is not optional—it's a requirement for sound unsafe code.

## Bad

```rust
/// Reads a value from a raw pointer.
pub unsafe fn read_ptr<T>(ptr: *const T) -> T {
    // What guarantees must the caller provide? Unknown!
    ptr.read()
}

/// Creates a string from raw parts.
pub unsafe fn string_from_raw(ptr: *mut u8, len: usize, cap: usize) -> String {
    String::from_raw_parts(ptr, len, cap)
}
```

## Good

```rust
/// Reads a value from a raw pointer.
///
/// # Safety
///
/// The caller must ensure that:
/// - `ptr` is valid for reads of `size_of::<T>()` bytes
/// - `ptr` is properly aligned for type `T`
/// - `ptr` points to a properly initialized value of type `T`
/// - The memory referenced by `ptr` is not mutated during this call
pub unsafe fn read_ptr<T>(ptr: *const T) -> T {
    ptr.read()
}

/// Creates a `String` from raw parts.
///
/// # Safety
///
/// The caller must guarantee that:
/// - `ptr` was allocated by the same allocator that `String` uses
/// - `len` is less than or equal to `cap`
/// - The first `len` bytes at `ptr` are valid UTF-8
/// - `cap` is the capacity that `ptr` was allocated with
/// - No other code will use `ptr` after this call (ownership is transferred)
///
/// Violating these requirements leads to undefined behavior including
/// memory corruption, use-after-free, or invalid UTF-8 in strings.
pub unsafe fn string_from_raw(ptr: *mut u8, len: usize, cap: usize) -> String {
    String::from_raw_parts(ptr, len, cap)
}
```

## Key Elements of Safety Documentation

| Element | Description |
|---------|-------------|
| **Preconditions** | What must be true before calling |
| **Pointer validity** | Alignment, null-ness, lifetime |
| **Memory ownership** | Who owns what, transfer semantics |
| **Invariants** | Type invariants that must hold |
| **Consequences** | What happens if violated |

## Pattern: Unsafe Trait Implementations

```rust
/// A type that can be safely zeroed.
///
/// # Safety
///
/// Implementing this trait guarantees that:
/// - All bit patterns of zeros represent a valid value of this type
/// - The type has no padding bytes that could leak data
/// - The type contains no references or pointers
pub unsafe trait Zeroable {
    fn zeroed() -> Self;
}

// SAFETY: u32 is a primitive integer type where all zero bits
// represent a valid value (0).
unsafe impl Zeroable for u32 {
    fn zeroed() -> Self {
        0
    }
}
```

## Pattern: Unsafe Blocks in Safe Functions

When a safe function contains unsafe blocks, document the invariants:

```rust
/// Returns a reference to the element at the given index.
///
/// Returns `None` if the index is out of bounds.
pub fn get(&self, index: usize) -> Option<&T> {
    if index < self.len {
        // SAFETY: We just verified that index < len, so this
        // access is within bounds.
        Some(unsafe { self.data.get_unchecked(index) })
    } else {
        None
    }
}
```

## Common Safety Requirements

```rust
/// # Safety
///
/// - Pointer must be non-null
/// - Pointer must be aligned to `align_of::<T>()`
/// - Pointer must be valid for reads/writes of `size_of::<T>()` bytes
/// - Pointer must point to an initialized value of `T`
/// - The referenced memory must not be accessed through any other pointer
///   for the duration of the returned reference
/// - The total size must not exceed `isize::MAX`
```

## See Also

- [doc-panics-section](./doc-panics-section.md) - Documenting panics
- [lint-unsafe-doc](./lint-unsafe-doc.md) - Enforcing unsafe documentation
- [doc-errors-section](./doc-errors-section.md) - Documenting errors
