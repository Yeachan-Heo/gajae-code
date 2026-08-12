# name-variants-camel

> Use `UpperCamelCase` for enum variants

## Why It Matters

Enum variants follow the same naming convention as types—`UpperCamelCase`. This distinguishes them from fields, variables, and functions. The compiler warns on violations, and consistent naming helps readers instantly recognize variant names.

## Bad

```rust
enum Status {
    pending,       // warning: variant `pending` should have an upper camel case name
    in_progress,   // warning
    COMPLETED,     // Not idiomatic
}

enum Color {
    RED,           // Screaming case - not Rust style
    GREEN,
    BLUE,
}
```

## Good

```rust
enum Status {
    Pending,
    InProgress,
    Completed,
    Failed,
}

enum Color {
    Red,
    Green,
    Blue,
    Custom(u8, u8, u8),
}

enum HttpMethod {
    Get,
    Post,
    Put,
    Delete,
    Patch,
}
```

## Variants with Data

```rust
enum Message {
    // Unit variant
    Quit,
    
    // Tuple variant
    Move(i32, i32),
    
    // Struct variant
    Write { text: String },
    
    // Named fields
    ChangeColor {
        red: u8,
        green: u8,
        blue: u8,
    },
}
```

## Variant Naming Tips

```rust
// Be specific
enum Error {
    NotFound,           // Good: specific
    PermissionDenied,   // Good: specific
    Error,              // Bad: vague
}

// Avoid redundant type name in variant
enum ConnectionState {
    Connected,          // Good
    Disconnected,       // Good
    ConnectionError,    // Bad: redundant "Connection"
}

// Use None/Some pattern for Option-like enums
enum MaybeValue<T> {
    Some(T),
    None,
}
```

## See Also

- [name-types-camel](./name-types-camel.md) - Type naming
- [api-non-exhaustive](./api-non-exhaustive.md) - Forward-compatible enums
- [type-enum-states](./type-enum-states.md) - State machine enums
