# unsafe-extern-block

> In Rust 2024, wrap `extern` blocks in `unsafe extern { }` and annotate each item as `safe` or `unsafe`.

## Why It Matters

Before Rust 2024, every function declared inside an `extern "C" { }` block was implicitly unsafe to call — but the block itself carried no `unsafe` keyword. This made it easy to forget that the FFI contract (correct types, valid pointers, no aliasing violations) was entirely the programmer's responsibility. Rust 2024 makes this explicit: the block must be `unsafe extern`, which signals that the *programmer* is asserting the declarations are accurate. Individual items can then be marked `safe` (callable without an `unsafe` block by the caller) or `unsafe` (the default — caller must use `unsafe {}`).

This change makes FFI boundaries auditable at a glance and lets wrappers expose a safe API while keeping raw declarations accurate.

## Bad

```rust
// Rust 2021 style — compiles but forbidden in 2024 edition
extern "C" {
    fn strlen(s: *const std::ffi::c_char) -> usize;
    fn memcpy(dst: *mut u8, src: *const u8, n: usize) -> *mut u8;
    static errno: std::ffi::c_int;
}
```

## Good

```rust
// Rust 2024 style
unsafe extern "C" {
    // `strlen` is genuinely unsafe: caller must pass a null-terminated pointer.
    pub unsafe fn strlen(s: *const std::ffi::c_char) -> usize;

    // `memcpy` is unsafe: caller must ensure non-overlapping, valid regions.
    pub unsafe fn memcpy(dst: *mut u8, src: *const u8, n: usize) -> *mut u8;

    // A function that is always safe to call (hypothetical pure query).
    pub safe fn rust_version_major() -> u32;

    // Statics are unsafe to access unless you can guarantee no data races.
    pub unsafe static errno: std::ffi::c_int;
}

// Call sites remain unchanged for `unsafe` items:
fn copy_bytes(dst: *mut u8, src: *const u8, n: usize) {
    // SAFETY: dst and src are non-overlapping, both valid for n bytes.
    unsafe { memcpy(dst, src, n) };
}

// Call sites for `safe` items need no unsafe block:
fn show_version() {
    println!("major: {}", rust_version_major());
}
```

## Migration from 2021

| 2021 | 2024 |
|------|------|
| `extern "C" { fn foo(); }` | `unsafe extern "C" { unsafe fn foo(); }` |
| `extern "C" { fn bar(); }` (safe to call) | `unsafe extern "C" { safe fn bar(); }` |
| `extern "C" { static X: i32; }` | `unsafe extern "C" { unsafe static X: i32; }` |

Run `cargo fix --edition` to apply the mechanical part of this migration automatically. Review each item afterward to decide whether `safe` is warranted.

## Key Points

- The `unsafe` on the block means "I assert these declarations faithfully describe the external ABI". It does not make calls to the items safe by itself.
- Marking an item `safe` is a promise: if that item is actually unsafe to call, adding `safe` is itself unsound — the compiler will not catch a wrong annotation.
- `bindgen` (0.70+) and `cbindgen` have been updated to emit `unsafe extern` blocks for Rust 2024 output. Update your code generator if you use one.
- The `extern "Rust"` ABI for cross-crate `#[no_mangle]` functions follows the same rules (see `unsafe-no-mangle-unsafe`).

## See Also

- [unsafe-no-mangle-unsafe](unsafe-no-mangle-unsafe.md) - mark `#[no_mangle]` as `#[unsafe(no_mangle)]` in Rust 2024
- [type-repr-transparent](type-repr-transparent.md) - use `#[repr(transparent)]` for FFI newtypes
