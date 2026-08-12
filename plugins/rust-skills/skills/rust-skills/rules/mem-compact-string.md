# mem-compact-string

> Use compact string types for memory-constrained string storage

## Why It Matters

Standard `String` is 24 bytes (pointer + length + capacity). For applications storing millions of short strings, this overhead dominates. Compact string libraries like `compact_str`, `smartstring`, or `ecow` store small strings inline (no heap allocation) and use optimized layouts for larger strings.

## Bad

```rust
struct User {
    id: u64,
    // Most usernames are < 24 chars, but String is always 24 bytes + heap
    username: String,
    email: String,
}

// 1 million users = 24 bytes * 2 * 1M = 48MB just for String metadata
// Plus all the heap allocations for actual content
```

## Good

```rust
use compact_str::CompactString;

struct User {
    id: u64,
    // CompactString: 24 bytes, but strings ≤ 23 bytes are inline (no heap)
    username: CompactString,
    email: CompactString,
}

// Most usernames fit inline = zero heap allocations
// Same memory footprint as String but way fewer allocations
```

## Compact String Libraries

### compact_str

```rust
use compact_str::CompactString;

// Inline storage for strings ≤ 23 bytes
let small: CompactString = "hello".into();  // No heap allocation

// Automatic heap fallback for larger strings
let large: CompactString = "x".repeat(100).into();

// String-like API
let mut s = CompactString::new("hello");
s.push_str(" world");
assert_eq!(s.as_str(), "hello world");

// Format macro
use compact_str::format_compact;
let s = format_compact!("value: {}", 42);
```

### smartstring

```rust
use smartstring::{SmartString, LazyCompact};

// Default is LazyCompact: 24 bytes inline capacity
let s: SmartString<LazyCompact> = "short string".into();

// Compact mode: 23 bytes inline on 64-bit
use smartstring::Compact;
let s: SmartString<Compact> = "hello".into();
```

### ecow (copy-on-write)

```rust
use ecow::EcoString;

// Clone is O(1) - shares underlying data
let s1: EcoString = "shared data".into();
let s2 = s1.clone();  // Cheap, shares allocation

// Copy-on-write: only allocates on mutation
let mut s3 = s1.clone();
s3.push_str(" modified");  // Now allocates
```

## Memory Comparison

```rust
use std::mem::size_of;

// All 24 bytes, but different inline capacities
assert_eq!(size_of::<String>(), 24);
assert_eq!(size_of::<compact_str::CompactString>(), 24);
assert_eq!(size_of::<smartstring::SmartString>(), 24);
assert_eq!(size_of::<ecow::EcoString>(), 16);  // Even smaller!
```

## Inline Capacity

| Type | Size | Inline Capacity |
|------|------|-----------------|
| `String` | 24 | 0 (always heap) |
| `CompactString` | 24 | 23 bytes [^1] |
| `SmartString<LazyCompact>` | 24 | 23 bytes |
| `EcoString` | 16 | 15 bytes |

[^1]: CompactString reserves the final byte of its 24-byte representation for a length tag, so the maximum inline string length is 23 bytes.

## When to Use

```rust
// ✅ Good: Many short strings in memory
struct Dictionary {
    words: Vec<CompactString>,  // Millions of short words
}

// ✅ Good: Frequently cloned strings
struct Template {
    parts: Vec<EcoString>,  // O(1) clone
}

// ❌ Don't: Hot path string manipulation
fn transform(s: &str) -> String {
    // Standard String is optimized for manipulation
    s.to_uppercase()
}

// ❌ Don't: API boundaries (prefer &str or String for interop)
pub fn public_api(input: CompactString) { }  // Forces dependency
pub fn public_api(input: impl Into<String>) { }  // Better
```

## Cargo.toml

```toml
[dependencies]
compact_str = "0.9"
# or
smartstring = "1.0"
# or
ecow = "0.2"
```

## See Also

- [mem-boxed-slice](./mem-boxed-slice.md) - Box<str> for immutable strings
- [own-cow-conditional](./own-cow-conditional.md) - Cow<str> for borrow-or-own
- [mem-smallvec](./mem-smallvec.md) - Similar concept for Vec
