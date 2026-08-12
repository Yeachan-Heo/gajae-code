# mem-smaller-integers

> Use appropriately-sized integers to reduce memory footprint

## Why It Matters

Using `i64` when `i16` suffices wastes 6 bytes per value. In arrays, vectors, and structs with millions of instances, this waste compounds dramatically. Choosing the smallest integer type that fits your domain reduces memory usage and improves cache utilization.

## Bad

```rust
struct Pixel {
    r: u64,  // Color channels 0-255 = 8 bits needed
    g: u64,  // Using 64 bits = 8x waste
    b: u64,
    a: u64,
}
// Size: 32 bytes per pixel

struct HttpStatus {
    code: i32,      // HTTP codes 100-599 = 10 bits needed
    version: i32,   // HTTP 1.0, 1.1, 2, 3 = 2 bits needed
}
// Size: 8 bytes per status

struct GeoPoint {
    lat: f64,   // -90 to 90
    lon: f64,   // -180 to 180
}
// Often f32 precision is sufficient for display
```

## Good

```rust
struct Pixel {
    r: u8,
    g: u8,
    b: u8,
    a: u8,
}
// Size: 4 bytes per pixel (8x smaller!)

struct HttpStatus {
    code: u16,      // 100-599 fits in u16
    version: u8,    // 1, 2, 3 fits in u8
}
// Size: 3 bytes (+ 1 padding = 4 bytes)

struct GeoPoint {
    lat: f32,   // ~7 decimal digits precision
    lon: f32,   // Sufficient for most geo applications
}
// Size: 8 bytes vs 16 bytes
```

## Integer Size Reference

| Type | Range | Use For |
|------|-------|---------|
| `u8` | 0 to 255 | Bytes, small counts, flags |
| `i8` | -128 to 127 | Small signed values |
| `u16` | 0 to 65,535 | Port numbers, small indices |
| `i16` | -32,768 to 32,767 | Audio samples |
| `u32` | 0 to 4 billion | Array indices, timestamps (seconds) |
| `i32` | ±2 billion | General integers, file offsets |
| `u64` | 0 to 18 quintillion | Large counts, nanosecond timestamps |
| `usize` | Platform-dependent | Array indexing (required by Rust) |

## Struct Packing

```rust
use std::mem::size_of;

// Poor ordering - 24 bytes due to padding
struct Wasteful {
    a: u8,    // 1 byte + 7 padding
    b: u64,   // 8 bytes
    c: u8,    // 1 byte + 7 padding
}
assert_eq!(size_of::<Wasteful>(), 24);

// Better ordering - 16 bytes
struct Efficient {
    b: u64,   // 8 bytes (aligned)
    a: u8,    // 1 byte
    c: u8,    // 1 byte + 6 padding
}
assert_eq!(size_of::<Efficient>(), 16);

// Even better with smaller types - 10 bytes
struct Compact {
    b: u32,   // 4 bytes (if u32 suffices)
    a: u8,    // 1 byte
    c: u8,    // 1 byte
}
assert_eq!(size_of::<Compact>(), 8);  // With padding
```

## Conversion Safety

```rust
// Safe: always succeeds (widening)
let small: u8 = 42;
let big: u32 = small.into();

// Fallible: may overflow (narrowing)
let big: u32 = 1000;
let small: u8 = big.try_into().expect("value out of range");

// Or use checked conversion
if let Ok(small) = u8::try_from(big) {
    use_small(small);
} else {
    handle_overflow();
}
```

## Bitflags for Boolean Sets

```rust
use bitflags::bitflags;

// Instead of 8 separate bool fields (8 bytes minimum)
bitflags! {
    struct Permissions: u8 {
        const READ    = 0b0000_0001;
        const WRITE   = 0b0000_0010;
        const EXECUTE = 0b0000_0100;
        const DELETE  = 0b0000_1000;
    }
}
// All 8 flags in 1 byte!

let perms = Permissions::READ | Permissions::WRITE;
if perms.contains(Permissions::READ) {
    // ...
}
```

## NonZero Types for Option Optimization

```rust
use std::num::NonZeroU64;

// Option<u64> = 16 bytes (no null pointer optimization)
assert_eq!(size_of::<Option<u64>>(), 16);

// Option<NonZeroU64> = 8 bytes (0 represents None)
assert_eq!(size_of::<Option<NonZeroU64>>(), 8);

let id: Option<NonZeroU64> = NonZeroU64::new(42);
```

## See Also

- [mem-box-large-variant](./mem-box-large-variant.md) - Optimizing enum sizes
- [mem-assert-type-size](./mem-assert-type-size.md) - Compile-time size checks
- [type-newtype-ids](./type-newtype-ids.md) - Type safety for integer IDs
- [num-nonzero](num-nonzero.md) - NonZero* niche optimization
- [num-cast-try-from](num-cast-try-from.md) - Avoid lossy `as` casts
