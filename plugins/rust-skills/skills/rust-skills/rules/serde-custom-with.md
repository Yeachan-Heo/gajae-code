# serde-custom-with

> Customize a field's (de)serialization with `with` / `serialize_with` / `deserialize_with`

## Why It Matters

Some types have a natural Rust representation that differs from what the wire format expects: a `Duration` stored as whole seconds, raw bytes encoded as base64, a timestamp as an ISO-8601 string. Changing the field type just to satisfy serde pollutes the domain model. A `#[serde(with = "module")]` (or the one-sided `serialize_with`/`deserialize_with`) attributes point serde at custom conversion functions without touching the field type.

## Bad

```rust
use serde::{Serialize, Deserialize};

// Forces a u64 "seconds" field instead of the natural Duration type
#[derive(Serialize, Deserialize, Debug)]
struct Task {
    name: String,
    timeout_secs: u64,   // callers must manually convert to/from Duration
}
```

## Good

```rust
use serde::{Serialize, Deserialize, Serializer, Deserializer};
use std::time::Duration;

mod duration_secs {
    use super::*;

    pub fn serialize<S>(duration: &Duration, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_u64(duration.as_secs())
    }

    pub fn deserialize<'de, D>(deserializer: D) -> Result<Duration, D::Error>
    where
        D: Deserializer<'de>,
    {
        let secs = u64::deserialize(deserializer)?;
        Ok(Duration::from_secs(secs))
    }
}

#[derive(Serialize, Deserialize, Debug)]
struct Task {
    name: String,
    // wire format: {"name":"...", "timeout": 30}
    // Rust type: Duration — no manual conversion needed at call sites
    #[serde(with = "duration_secs", rename = "timeout")]
    timeout: Duration,
}

// One-sided variants when you only need to customize one direction:
#[derive(Serialize, Deserialize, Debug)]
struct Report {
    title: String,
    #[serde(serialize_with = "duration_secs::serialize")]
    elapsed: Duration,
    // deserialize_with leaves the deserialize direction at its default
}
```

## Key Points

- `#[serde(with = "module")]` requires the module to expose both `pub fn serialize<S>(&T, S) -> Result<S::Ok, S::Error>` and `pub fn deserialize<'de, D>(D) -> Result<T, D::Error>`.
- Use `serialize_with = "path"` or `deserialize_with = "path"` to customize only one direction, leaving the other at its derived default.
- The module approach (`with`) is more reusable: define it once, apply it anywhere. Some crates (e.g. `time`, `chrono`, `uuid`) ship ready-made `with` modules in their serde feature.
- For widespread custom representations, a newtype wrapper with its own `Serialize`/`Deserialize` impl is often cleaner than repeating `#[serde(with = "...")]` everywhere.

## Caveats

The `with` module functions must match the exact signatures serde expects. The `serialize` function receives `&T` (a reference), not `T`.

## See Also

- [serde-try-from-validate](serde-try-from-validate.md) - validate while deserializing with TryFrom
- [type-newtype-validated](type-newtype-validated.md) - newtypes for validated data
