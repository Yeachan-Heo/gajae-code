# const-block

> Use inline `const { }` blocks for compile-time evaluation and assertions

## Why It Matters

A `const { }` block (stabilized in Rust 1.79) forces the enclosed expression to be evaluated at compile time, even inside a regular function. This has three practical uses: compile-time assertions that fail the build rather than panicking at runtime; precomputed values inlined at the exact call site without a named `const` item; and initializing arrays of non-`Copy` types that require a per-element constant expression. Catching invariant violations at compile time gives a clearer error message and zero runtime cost.

## Bad

```rust
const SIZE: usize = 64;

fn process(buf: &[u8]) {
    // runtime panic — error surface is deferred until execution
    assert!(SIZE.is_power_of_two(), "SIZE must be a power of two");
    assert!(buf.len() <= SIZE);
}

// repeated magic number — easy to get out of sync
fn header() -> [u8; 4] {
    [0u8; 4]
}

// initializing array of non-Copy type requires unsafe or a workaround without const blocks
// std::array::from_fn is fine, but const blocks make the intent clearer for const values
```

## Good

```rust
const SIZE: usize = 64;

fn process(buf: &[u8]) {
    // compile-time assertion — build fails immediately if SIZE changes to a bad value
    const { assert!(SIZE.is_power_of_two(), "SIZE must be a power of two") };

    // runtime assertion for dynamic data still makes sense here
    assert!(buf.len() <= SIZE);
}

// inline const block used as a value — evaluated once, inlined at each use
fn magic_header() -> u32 {
    const { 0xDEAD_BEEFu32.swap_bytes() }
}

// compile-time bounds check on a type-level relationship
struct Packet<const HDR: usize, const BODY: usize>;

impl<const HDR: usize, const BODY: usize> Packet<HDR, BODY> {
    fn new() -> Self {
        // fails at compile time if the relationship is violated, not at runtime
        const { assert!(HDR + BODY <= 1500, "packet exceeds ethernet MTU") };
        Packet
    }
}

// array of non-Copy type using a const block per element
// (each element is its own const expression — legal since 1.79)
fn make_table() -> [u64; 4] {
    [
        const { u64::MAX / 1 },
        const { u64::MAX / 2 },
        const { u64::MAX / 3 },
        const { u64::MAX / 4 },
    ]
}
```

## Notes

`const { expr }` is an expression, so it can appear anywhere an expression is valid: in function bodies, match arms, array initializers, and as default values. It is distinct from a named `const ITEM: T = expr;` declaration — a `const` block is anonymous and scoped to its enclosing expression. For long-lived or widely shared values, prefer a named `const`; reach for `const { }` when you want a one-off compile-time guarantee or value inline.

## See Also

- [const-fn](const-fn.md) - write functions callable in const contexts
- [mem-assert-type-size](mem-assert-type-size.md) - assert hot type sizes to prevent layout regressions
