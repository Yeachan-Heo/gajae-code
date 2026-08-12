# serde-enum-representation

> Choose enum tagging deliberately: externally, internally, adjacently tagged, or untagged

## Why It Matters

Serde's default enum representation (externally tagged) wraps every variant in an object keyed by variant name. That format can clash with external APIs, event systems, or config schemas that use a discriminator field. Picking the wrong tagging strategy produces a mismatch between your wire format and the expected schema, leading to silent parse failures or round-trip data loss.

## Bad

```rust
use serde::{Serialize, Deserialize};

// Default: externally tagged. Serializes as {"Circle":{"radius":5.0}}
// Most REST APIs expect {"type":"circle","radius":5.0} instead.
#[derive(Serialize, Deserialize, Debug)]
enum Shape {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
}
```

## Good

```rust
use serde::{Serialize, Deserialize};

// Externally tagged (default) — {"Circle":{"radius":5.0}}
// Good for: Rust-to-Rust, when the variant name IS the key
#[derive(Serialize, Deserialize, Debug)]
enum ShapeExternal {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
}

// Internally tagged — {"type":"Circle","radius":5.0}
// Good for: REST APIs with a discriminator field; all variants must be structs/maps
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
enum ShapeInternal {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
}

// Adjacently tagged — {"t":"Circle","c":{"radius":5.0}}
// Good for: when variants may contain primitives or vecs (internally tagged can't handle those)
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "t", content = "c")]
enum ShapeAdjacent {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
    Count(u32),  // tuple variant — works here, but NOT with internally tagged
}

// Untagged — {"radius":5.0}
// Good for: wrapping a small number of clearly distinct types; avoid otherwise
#[derive(Serialize, Deserialize, Debug)]
#[serde(untagged)]
enum Value {
    Integer(i64),
    Float(f64),
    Text(String),
}
```

## Comparison Table

| Strategy | Attribute | Wire form (Circle) | Tuple variant |
|---|---|---|---|
| Externally tagged | (default) | `{"Circle":{"radius":5}}` | yes |
| Internally tagged | `#[serde(tag = "type")]` | `{"type":"Circle","radius":5}` | no |
| Adjacently tagged | `#[serde(tag="t", content="c")]` | `{"t":"Circle","c":{"radius":5}}` | yes |
| Untagged | `#[serde(untagged)]` | `{"radius":5}` | yes |

## Caveats

- **Untagged** deserializes by trying each variant in declaration order; it is slower, can silently pick the wrong variant, and produces generic error messages. Reserve it for small, structurally distinct sets (numbers vs strings).
- **Internally tagged** cannot represent tuple variants or newtype variants wrapping primitives/vecs — use adjacently tagged instead.
- All variants in an internally tagged enum must serialize as maps (structs or `HashMap`).

## See Also

- [type-enum-states](type-enum-states.md) - use enums for mutually exclusive states
- [api-non-exhaustive](api-non-exhaustive.md) - use `#[non_exhaustive]` for future-proof enums
- [serde-flatten](serde-flatten.md) - inline nested struct fields into parent
