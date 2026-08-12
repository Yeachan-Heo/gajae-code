# serde-rename-all

> Match the external naming convention with `#[serde(rename_all = ...)]`

## Why It Matters

Rust fields are `snake_case` by convention, but JSON APIs, GraphQL responses, and config formats often use `camelCase`, `kebab-case`, or `SCREAMING_SNAKE_CASE`. Renaming every field individually with `#[serde(rename = "...")]` is noisy and error-prone. A single `#[serde(rename_all = "camelCase")]` on the container keeps Rust idiomatic and the wire format correct in one declaration.

## Bad

```rust
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
struct UserProfile {
    #[serde(rename = "firstName")]
    first_name: String,
    #[serde(rename = "lastName")]
    last_name: String,
    #[serde(rename = "emailAddress")]
    email_address: String,
    #[serde(rename = "isActive")]
    is_active: bool,
}
```

## Good

```rust
use serde::{Serialize, Deserialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserProfile {
    first_name: String,
    last_name: String,
    email_address: String,
    is_active: bool,
    // per-field override: "type" is a keyword in Rust, so we rename it explicitly
    #[serde(rename = "type")]
    user_type: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
enum Status {
    Active,
    Inactive,
    PendingVerification,
}
```

## Key Points

`rename_all` applies to both serialization and deserialization. Supported values:

| Value | Example field `foo_bar` becomes |
|---|---|
| `"camelCase"` | `fooBar` |
| `"PascalCase"` | `FooBar` |
| `"kebab-case"` | `foo-bar` |
| `"SCREAMING_SNAKE_CASE"` | `FOO_BAR` |
| `"snake_case"` | `foo_bar` (identity) |
| `"UPPERCASE"` | `FOOBAR` |
| `"lowercase"` | `foobar` |

A field-level `#[serde(rename = "...")]` always wins over the container-level `rename_all`, so use it for exceptions like reserved words or one-off mismatches. For enums, `rename_all` applies to variant names.

## See Also

- [serde-default-compat](serde-default-compat.md) - add default values for backward-compatible fields
- [api-serde-optional](api-serde-optional.md) - gate serde behind a feature flag in libraries
