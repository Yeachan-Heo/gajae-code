# api-default-impl

> Implement `Default` for types with sensible default values

## Why It Matters

`Default` is a standard trait that provides a canonical way to create a default instance. It integrates with many ecosystem patterns: `Option::unwrap_or_default()`, `#[derive(Default)]`, struct update syntax `..Default::default()`, and generic code that requires `T: Default`. Implementing it makes your types more ergonomic.

## Bad

```rust
struct Config {
    timeout: Duration,
    retries: u32,
    verbose: bool,
}

impl Config {
    // Custom constructor - works but non-standard
    fn new() -> Self {
        Config {
            timeout: Duration::from_secs(30),
            retries: 3,
            verbose: false,
        }
    }
}

// Can't use with standard patterns
let config: Config = Default::default();  // Error: Default not implemented
let timeout = settings.get("timeout").unwrap_or_default();  // Won't work
```

## Good

```rust
use std::time::Duration;

// Simple case: derive uses each field type's Default (Duration::ZERO, 0, false)
#[derive(Default)]
struct Config {
    timeout: Duration,
    retries: u32,
    verbose: bool,
}
```

For a non-zero default, implement `Default` by hand instead of deriving. (Per-field defaults like `timeout: Duration = Duration::from_secs(30)` require the nightly `default_field_values` feature.)

```rust
use std::time::Duration;

struct Config {
    timeout: Duration,
    retries: u32,
    verbose: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            timeout: Duration::from_secs(30),
            retries: 3,
            verbose: false,
        }
    }
}

// Now works with all standard patterns
let config = Config::default();
let config = Config { retries: 5, ..Default::default() };
let value = map.get("key").cloned().unwrap_or_default();
```

## Derive vs Manual

```rust
// Derive: all fields use their own Default
#[derive(Default)]
struct Simple {
    count: u32,      // 0
    name: String,    // ""
    items: Vec<i32>, // []
}

// Manual: when you need custom defaults
struct Connection {
    host: String,
    port: u16,
    timeout: Duration,
}

impl Default for Connection {
    fn default() -> Self {
        Connection {
            host: "localhost".to_string(),
            port: 8080,
            timeout: Duration::from_secs(30),
        }
    }
}
```

## Builder with Default

```rust
#[derive(Default)]
struct ServerBuilder {
    host: String,
    port: u16,
    workers: usize,
}

impl ServerBuilder {
    fn host(mut self, host: impl Into<String>) -> Self {
        self.host = host.into();
        self
    }
    
    fn port(mut self, port: u16) -> Self {
        self.port = port;
        self
    }
}

// Clean initialization
let server = ServerBuilder::default()
    .host("0.0.0.0")
    .port(3000)
    .build();
```

## Default with Required Fields

```rust
// When some fields have no sensible default, don't implement Default
struct User {
    id: UserId,       // No sensible default
    name: String,     // Could default to ""
}

// Instead, provide a constructor
impl User {
    fn new(id: UserId, name: impl Into<String>) -> Self {
        User { id, name: name.into() }
    }
}

// Or use builder with required fields
struct UserBuilder {
    id: Option<UserId>,
    name: String,
}

impl Default for UserBuilder {
    fn default() -> Self {
        UserBuilder {
            id: None,
            name: String::new(),
        }
    }
}
```

## Generic Default

```rust
// Require Default in generic bounds when needed
fn create_or_default<T: Default>(opt: Option<T>) -> T {
    opt.unwrap_or_default()
}

// PhantomData is Default regardless of T
use std::marker::PhantomData;
struct Wrapper<T> {
    _marker: PhantomData<T>,
}

impl<T> Default for Wrapper<T> {
    fn default() -> Self {
        Wrapper { _marker: PhantomData }
    }
}
```

## See Also

- [api-builder-pattern](./api-builder-pattern.md) - Building complex types
- [api-common-traits](./api-common-traits.md) - Other common traits to implement
- [api-from-not-into](./api-from-not-into.md) - Conversion traits
