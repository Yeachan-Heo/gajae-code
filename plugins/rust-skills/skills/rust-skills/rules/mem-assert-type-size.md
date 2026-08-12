# mem-assert-type-size

> Use static assertions to guard against accidental type size growth

## Why It Matters

Adding a field to a frequently-instantiated struct can silently bloat memory usage. Static size assertions catch this at compile time, making size changes intentional rather than accidental. This is especially important for types stored in large collections or passed frequently by value.

## Bad

```rust
struct Event {
    timestamp: u64,
    kind: EventKind,
    payload: [u8; 32],
}

// Later, someone adds a field without realizing the impact
struct Event {
    timestamp: u64,
    kind: EventKind,
    payload: [u8; 32],
    metadata: String,  // Silently adds 24 bytes!
}

// 10 million events now use 240MB more memory
// No warning, no review trigger
```

## Good

```rust
struct Event {
    timestamp: u64,
    kind: EventKind,
    payload: [u8; 32],
}

// Static assertion - breaks compile if size changes
const _: () = assert!(std::mem::size_of::<Event>() == 48);

// Or with static_assertions crate
use static_assertions::assert_eq_size;
assert_eq_size!(Event, [u8; 48]);

// Now adding metadata triggers compile error:
// error: assertion failed: std::mem::size_of::<Event>() == 48
```

## static_assertions Crate

```rust
use static_assertions::{assert_eq_size, const_assert};

struct Critical {
    id: u64,
    flags: u32,
    data: [u8; 16],
}

// Exact size assertion
assert_eq_size!(Critical, [u8; 32]);

// Maximum size assertion
const_assert!(std::mem::size_of::<Critical>() <= 64);

// Alignment assertion
const_assert!(std::mem::align_of::<Critical>() == 8);

// Compare sizes
assert_eq_size!(Critical, [u64; 4]);
```

## Built-in Const Assertions

```rust
// No external crate needed (Rust 1.57+)
struct Packet {
    header: u32,
    payload: [u8; 60],
}

const _: () = assert!(
    std::mem::size_of::<Packet>() == 64,
    "Packet must be exactly 64 bytes for protocol compliance"
);

// Compile error shows custom message if assertion fails
```

## Documenting Size Constraints

```rust
/// Network protocol packet header.
/// 
/// # Size
/// 
/// This struct is guaranteed to be exactly 32 bytes to match
/// the network protocol specification. Any changes to fields
/// must maintain this size constraint.
#[repr(C)]  // Predictable layout for FFI
struct Header {
    version: u16,
    flags: u16,
    length: u32,
    checksum: u64,
    reserved: [u8; 16],
}

const _: () = assert!(std::mem::size_of::<Header>() == 32);
```

## Testing Size Stability

```rust
#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn critical_types_have_expected_sizes() {
        // Document expected sizes in tests too
        assert_eq!(std::mem::size_of::<Event>(), 48);
        assert_eq!(std::mem::size_of::<Message>(), 64);
        assert_eq!(std::mem::size_of::<Header>(), 32);
    }
    
    #[test]
    fn cache_line_aligned() {
        // Verify cache-friendly sizing
        assert!(std::mem::size_of::<HotData>() <= 64);
    }
}
```

## When to Assert

```rust
// ✅ Types stored in large collections
struct Node { /* ... */ }
const _: () = assert!(std::mem::size_of::<Node>() <= 64);

// ✅ Types used in FFI / binary protocols
#[repr(C)]
struct WireFormat { /* ... */ }
const _: () = assert!(std::mem::size_of::<WireFormat>() == 256);

// ✅ Performance-critical types
struct HotPath { /* ... */ }
const _: () = assert!(std::mem::size_of::<HotPath>() <= 128);

// ❌ Skip for rarely-instantiated types
struct AppConfig { /* many fields */ }
// Size doesn't matter, only one instance
```

## Cargo.toml

```toml
[dependencies]
static_assertions = "1.1"
```

## See Also

- [mem-smaller-integers](./mem-smaller-integers.md) - Choosing appropriate integer sizes
- [mem-box-large-variant](./mem-box-large-variant.md) - Managing enum variant sizes
- [opt-cache-friendly](./opt-cache-friendly.md) - Cache line considerations
