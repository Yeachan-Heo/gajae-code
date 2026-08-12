# api-common-traits

> Implement standard traits (Debug, Clone, PartialEq, etc.) for public types

## Why It Matters

Standard traits make your types interoperable with the Rust ecosystem. `Debug` enables `println!("{:?}")` and error messages. `Clone` allows explicit duplication. `PartialEq` enables `==`. Without these, users can't use your types in common patterns like testing, collections, or debugging.

## Bad

```rust
// Bare struct - severely limited usability
pub struct Point {
    pub x: f64,
    pub y: f64,
}

// Can't debug
println!("{:?}", point);  // Error: Debug not implemented

// Can't compare
if point1 == point2 { }  // Error: PartialEq not implemented

// Can't use in HashMap
let mut map: HashMap<Point, Value> = HashMap::new();  // Error: Hash not implemented

// Can't clone
let copy = point.clone();  // Error: Clone not implemented
```

## Good

```rust
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

// Now everything works
println!("{:?}", point);
assert_eq!(point1, point2);
let copy = point;  // Copy, not just Clone

// For hashable types
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct UserId(u64);

let mut map: HashMap<UserId, User> = HashMap::new();
```

## Trait Derivation Guide

| Trait | Derive When | Requirements |
|-------|-------------|--------------|
| `Debug` | Always for public types | All fields implement Debug |
| `Clone` | Type can be duplicated | All fields implement Clone |
| `Copy` | Small, simple types | All fields implement Copy, no Drop |
| `PartialEq` | Comparison makes sense | All fields implement PartialEq |
| `Eq` | Total equality | PartialEq, no floating-point fields |
| `Hash` | Used as HashMap/HashSet key | Eq, consistent with PartialEq |
| `Default` | Sensible default exists | All fields implement Default |
| `PartialOrd` | Ordering makes sense | PartialEq, all fields implement PartialOrd |
| `Ord` | Total ordering | Eq + PartialOrd, no floating-point |

## Common Trait Bundles

```rust
// ID types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct EntityId(u64);

// Value types
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Vector2 { x: f32, y: f32 }

// Configuration
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Config {
    name: String,
    options: HashMap<String, String>,
}

// Error types
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    InvalidSyntax(String),
    UnexpectedToken(Token),
}
```

## Manual Implementations

```rust
// When derive doesn't do what you want
struct CaseInsensitiveString(String);

impl PartialEq for CaseInsensitiveString {
    fn eq(&self, other: &Self) -> bool {
        self.0.to_lowercase() == other.0.to_lowercase()
    }
}

impl Eq for CaseInsensitiveString {}

impl Hash for CaseInsensitiveString {
    fn hash<H: Hasher>(&self, state: &mut H) {
        // Must be consistent with PartialEq
        self.0.to_lowercase().hash(state);
    }
}

// Custom Debug for sensitive data
struct Password(String);

impl Debug for Password {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Password([REDACTED])")
    }
}
```

## Serde Traits

```rust
use serde::{Serialize, Deserialize};

// For serializable types
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ApiResponse {
    pub status: String,
    pub data: Vec<Item>,
}

// With custom serialization
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub verbose: bool,
    
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
}
```

## Minimum Recommended

```rust
// At minimum, public types should have:
#[derive(Debug, Clone, PartialEq)]
pub struct MyType { ... }

// Add based on use case:
// + Eq, Hash       → for HashMap keys
// + Ord, PartialOrd → for BTreeMap, sorting
// + Default        → for Option::unwrap_or_default()
// + Copy           → for small value types
// + Serialize      → for serialization
```

## See Also

- [own-copy-small](./own-copy-small.md) - When to implement Copy
- [api-default-impl](./api-default-impl.md) - Implementing Default
- [doc-examples-section](./doc-examples-section.md) - Documenting trait implementations
- [type-display-vs-debug](./type-display-vs-debug.md) - Display vs Debug responsibilities
