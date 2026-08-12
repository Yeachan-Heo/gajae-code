# type-numeric-fmt

> Implement `LowerHex`, `UpperHex`, `Octal`, and `Binary` for numeric newtypes

## Why It Matters

Rust's API Guidelines (C-NUM-FMT) state that numeric types should support `{:x}`, `{:X}`, `{:o}`, and `{:b}` wherever the underlying integer type does. A numeric newtype that silently drops these format specifiers is an ergonomic regression — callers who reach for `{:x}` to debug a bitmask or address will hit a compile error instead. The fix is a one-liner per trait that forwards to the inner value's formatter.

## Bad

```rust
use std::fmt;

struct Mask(u32);

impl fmt::Display for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

fn main() {
    let m = Mask(0xDEAD_BEEF);
    println!("{}", m);   // ok
    // println!("{:x}", m); // compile error: Mask doesn't implement LowerHex
}
```

## Good

```rust
use std::fmt;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Mask(u32);

impl fmt::Display for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

impl fmt::LowerHex for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::LowerHex::fmt(&self.0, f)
    }
}

impl fmt::UpperHex for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::UpperHex::fmt(&self.0, f)
    }
}

impl fmt::Octal for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Octal::fmt(&self.0, f)
    }
}

impl fmt::Binary for Mask {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Binary::fmt(&self.0, f)
    }
}

fn main() {
    let m = Mask(0xDEAD_BEEF);
    println!("{m}");          // 3735928559
    println!("{m:x}");        // deadbeef
    println!("{m:X}");        // DEADBEEF
    println!("{m:#010x}");    // 0xdeadbeef
    println!("{m:o}");        // 33653337357
    println!("{m:b}");        // 11011110101011011011111011101111
}
```

## Notes

- Forward through the inner type's trait implementation (e.g., `fmt::LowerHex::fmt(&self.0, f)`) so that format flags like `#`, `0`, and width are handled correctly by the inner type.
- Apply this to any newtype whose inner type is a primitive integer (`u8`–`u128`, `i8`–`i128`, `usize`, `isize`).
- Skip `Octal`/`Binary` if there is genuinely no domain reason to print the value in those bases (e.g., a purely decimal `Count` newtype), but always implement `LowerHex`/`UpperHex` for any mask, address, or identifier type.

## See Also

- [type-newtype-ids](type-newtype-ids.md) - wrapping IDs and numeric values in newtypes
- [type-display-vs-debug](type-display-vs-debug.md) - choosing between `Display` and `Debug`
