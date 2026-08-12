# unsafe-safety-comment

> Write a `// SAFETY:` comment above every `unsafe` block and a `# Safety` section in every `unsafe fn`.

## Why It Matters

Unsafe blocks are unauditable without justification. A reviewer cannot verify invariants they cannot read. The `clippy::undocumented_unsafe_blocks` lint enforces this mechanically. The standard library, tokio, and bevy all require both forms before merging unsafe code.

There are two distinct levels of documentation:

1. **`# Safety` in a doc comment on an `unsafe fn`** — describes the *caller's* obligations (preconditions that must hold for the call to be sound).
2. **`// SAFETY:` inline comment above each `unsafe {}` block** — explains why *this specific operation* upholds the required invariants at the call site.

Both are required. Omitting either leaves an auditor unable to verify soundness.

## Bad

```rust
// unsafe fn with no # Safety section — caller has no idea what's required
pub unsafe fn read_at(ptr: *const u8, offset: usize) -> u8 {
    // no SAFETY comment — why is this dereference sound?
    unsafe { *ptr.add(offset) }
}

// standalone block with no justification
fn process(slice: &[u8]) -> u8 {
    unsafe { *slice.as_ptr().add(10) }
}
```

## Good

```rust
/// Returns the byte at `ptr + offset`.
///
/// # Safety
///
/// - `ptr` must be valid for reads for at least `offset + 1` bytes.
/// - `ptr` must not be null and must be properly aligned for `u8`.
/// - The memory must not be mutated for the duration of this call.
pub unsafe fn read_at(ptr: *const u8, offset: usize) -> u8 {
    // SAFETY: caller guarantees ptr is valid for at least offset + 1 bytes,
    // so ptr.add(offset) is in bounds and dereferenceable.
    unsafe { *ptr.add(offset) }
}

fn process(slice: &[u8]) -> Option<u8> {
    if slice.len() > 10 {
        // SAFETY: we just checked that slice has at least 11 elements,
        // so index 10 is within bounds.
        Some(unsafe { *slice.as_ptr().add(10) })
    } else {
        None
    }
}
```

## Key Points

- A `# Safety` doc section and a `// SAFETY:` inline comment serve different audiences: the doc section targets *callers*, the inline comment targets *auditors* of the implementation.
- Enable the lint explicitly to catch omissions:
  ```rust
  #![warn(clippy::undocumented_unsafe_blocks)]
  ```
- When an unsafe block spans multiple operations, write one `// SAFETY:` comment that addresses each distinct invariant, or split into multiple smaller blocks (see `unsafe-minimize-scope`).
- In an `unsafe fn`, the body still requires `// SAFETY:` comments for each inner `unsafe {}` block under the 2024 edition's `unsafe_op_in_unsafe_fn` lint.

## See Also

- [unsafe-minimize-scope](unsafe-minimize-scope.md) - keep unsafe blocks as small as possible
- [lint-unsafe-doc](lint-unsafe-doc.md) - enable `clippy::undocumented_unsafe_blocks`
- [doc-safety-section](doc-safety-section.md) - include `# Safety` sections in public unsafe fns
