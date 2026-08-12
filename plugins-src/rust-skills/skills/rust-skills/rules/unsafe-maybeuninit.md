# unsafe-maybeuninit

> Use `MaybeUninit<T>` for uninitialized memory; never use `mem::uninitialized()` or `mem::zeroed()` for types with validity invariants.

## Why It Matters

`mem::uninitialized()` was deprecated in Rust 1.39 and is immediate undefined behavior for any type whose bit patterns have validity invariants — `bool` (only `0` and `1` are valid), `&T` (must be non-null and aligned), `NonZeroU32`, `char`, and enum types. Even `mem::zeroed()` triggers UB for references and `NonZero*` types. `MaybeUninit<T>` is the correct abstraction: it wraps uninitialized memory without ever producing an invalid `T`, and the compiler cannot optimize around it incorrectly. The standard library uses `MaybeUninit` pervasively for its data structures.

## Bad

```rust
use std::mem;

// Instant UB: `bool` has validity invariants; uninitialized bits are not
// guaranteed to be 0 or 1. The optimizer may miscompile code that follows.
let b: bool = unsafe { mem::uninitialized() };

// Also UB for references — a zero reference is immediately invalid.
let r: &u32 = unsafe { mem::zeroed() };

// Uninitialized array the wrong way — triggers UB during construction.
let mut buf: [u8; 1024] = unsafe { mem::uninitialized() };
```

## Good

```rust
use std::mem::MaybeUninit;

// ---- 1. Single value ----
let mut x = MaybeUninit::<u32>::uninit();
x.write(42);
// SAFETY: we just wrote a valid u32 via `write`, so the value is initialized.
let value: u32 = unsafe { x.assume_init() };

// ---- 2. Array initialization (manual, element-by-element) ----
// `[const { MaybeUninit::uninit() }; N]` works for any `T` (no `Copy` bound).
let mut buf: [MaybeUninit<u8>; 1024] = [const { MaybeUninit::uninit() }; 1024];
for elem in &mut buf {
    elem.write(0u8);
}
// SAFETY: every element was written above.
// `From<[MaybeUninit<T>; N]> for MaybeUninit<[T; N]>` is stable since Rust 1.95.
let buf: [u8; 1024] = unsafe {
    MaybeUninit::<[u8; 1024]>::from(buf).assume_init()
};

// ---- 3. Growing a Vec into spare capacity ----
fn fill_vec(v: &mut Vec<u8>, extra: usize) {
    v.reserve(extra);
    let spare = v.spare_capacity_mut(); // &mut [MaybeUninit<u8>]
    for slot in spare.iter_mut().take(extra) {
        slot.write(0u8);
    }
    // SAFETY: we initialized `extra` elements in the spare capacity.
    unsafe { v.set_len(v.len() + extra) };
}
```

## Key Points

- **`assume_init` is only sound after every byte is initialized** via `write`, an FFI call that fills the buffer, or another provably complete initialization path. Calling it on partially initialized memory is UB.
- Create arrays of uninitialized memory with `[const { MaybeUninit::uninit() }; N]` (works for any `T`). Convert a fully-initialized `[MaybeUninit<T>; N]` to `[T; N]` via `MaybeUninit::<[T; N]>::from(arr)` then `assume_init()` — these `From` conversions are stable since Rust 1.95. The `MaybeUninit::array_assume_init` helper remains nightly-only (feature `maybe_uninit_array_assume_init`).
- `Vec::spare_capacity_mut` returns `&mut [MaybeUninit<T>]` — the idiomatic way to write into Vec capacity before extending its length.
- For zeroed memory where zero is a valid bit pattern for all fields (e.g. `u8`, `i32`, plain C structs with no references), `mem::zeroed()` is technically sound but `MaybeUninit` is still preferred for clarity.
- `mem::uninitialized` is not just deprecated — it is `#[deprecated(since = "1.39.0")]` and has no safe migration; replace every usage with `MaybeUninit`.

## See Also

- [unsafe-safety-comment](unsafe-safety-comment.md) - document every unsafe block including `assume_init` calls
- [mem-with-capacity](mem-with-capacity.md) - use `with_capacity` when size is known to avoid extra allocations
