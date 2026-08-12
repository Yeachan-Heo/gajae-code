# api-serde-optional

> Make serde a feature flag, not a hard dependency for library crates

## Why It Matters

Not all users of your library need serialization. Making serde a required dependency adds compile time and binary size for everyone. Feature flags let users opt-in to serde support only when needed, following Rust's philosophy of zero-cost abstractions and minimal dependencies.

## Bad

```rust
// Cargo.toml
[dependencies]
serde = { version = "1.0", features = ["derive"] }

// lib.rs
use serde::{Serialize, Deserialize};

// Every user pays for serde, even if they don't need it
#[derive(Serialize, Deserialize)]
pub struct Config {
    pub name: String,
    pub value: i32,
}
```

## Good

```rust
// Cargo.toml
[dependencies]
serde = { version = "1.0", features = ["derive"], optional = true }

[features]
default = []
serde = ["dep:serde"]

// lib.rs
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Config {
    pub name: String,
    pub value: i32,
}

// Users opt-in:
// my_crate = { version = "1.0", features = ["serde"] }
```

## Macro Pattern

```rust
// Reusable macro for serde derives
#[cfg(feature = "serde")]
macro_rules! impl_serde {
    ($($t:ty),*) => {
        $(
            impl serde::Serialize for $t {
                // ...
            }
            impl<'de> serde::Deserialize<'de> for $t {
                // ...
            }
        )*
    };
}

#[cfg(not(feature = "serde"))]
macro_rules! impl_serde {
    ($($t:ty),*) => {};
}

// Or use cfg_attr for derived impls
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
```

## Feature Documentation

```rust
// lib.rs

//! # Features
//!
//! - `serde`: Enables `Serialize` and `Deserialize` implementations for all types.
//!
//! # Example with serde
//!
//! ```toml
//! [dependencies]
//! my_crate = { version = "1.0", features = ["serde"] }
//! ```

#![cfg_attr(docsrs, feature(doc_cfg))]

/// A configuration type.
/// 
/// When the `serde` feature is enabled, this type implements
/// `Serialize` and `Deserialize`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(docsrs, doc(cfg(feature = "serde")))]
pub struct Config {
    pub name: String,
}
```

## Multiple Optional Dependencies

```rust
// Cargo.toml
[dependencies]
serde = { version = "1.0", features = ["derive"], optional = true }
rkyv = { version = "0.7", optional = true }
borsh = { version = "0.10", optional = true }

[features]
default = []
serde = ["dep:serde"]
rkyv = ["dep:rkyv"]
borsh = ["dep:borsh"]

// lib.rs
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "rkyv", derive(rkyv::Archive, rkyv::Serialize, rkyv::Deserialize))]
#[cfg_attr(feature = "borsh", derive(borsh::BorshSerialize, borsh::BorshDeserialize))]
pub struct Message {
    pub id: u64,
    pub content: String,
}
```

## Testing with Features

```bash
# Test without serde
cargo test

# Test with serde
cargo test --features serde

# Test all feature combinations
cargo test --all-features
```

```rust
// Test serde round-trip when feature enabled
#[cfg(feature = "serde")]
#[test]
fn test_serde_roundtrip() {
    let config = Config { name: "test".into() };
    let json = serde_json::to_string(&config).unwrap();
    let parsed: Config = serde_json::from_str(&json).unwrap();
    assert_eq!(config, parsed);
}
```

## When to Make Serde Required

```rust
// ✅ Required: Library is about serialization
// (e.g., json-schema, config-file parser)
[dependencies]
serde = "1.0"

// ✅ Required: Domain heavily uses serde
// (e.g., API client, data format library)

// ❌ Optional: General-purpose utility library
// ❌ Optional: Math/algorithm library
// ❌ Optional: Most libraries!
```

## See Also

- [proj-lib-main-split](./proj-lib-main-split.md) - Library structure
- [api-common-traits](./api-common-traits.md) - Core trait implementations
- [lint-deny-correctness](./lint-deny-correctness.md) - Feature testing
- [serde-try-from-validate](./serde-try-from-validate.md) - Validate while deserializing
- [serde-rename-all](./serde-rename-all.md) - Match external naming conventions
