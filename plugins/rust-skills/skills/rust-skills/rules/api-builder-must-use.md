# api-builder-must-use

> Mark builder methods with `#[must_use]` to prevent silent drops

## Why It Matters

Builder pattern methods return a modified builder. Without `#[must_use]`, calling a builder method and ignoring the return value silently does nothing—the builder is dropped, and the configuration is lost. This creates confusing bugs where code appears correct but has no effect.

## Bad

```rust
struct RequestBuilder {
    url: String,
    timeout: Option<Duration>,
    headers: Vec<(String, String)>,
}

impl RequestBuilder {
    fn timeout(mut self, duration: Duration) -> Self {
        self.timeout = Some(duration);
        self
    }
    
    fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.to_string(), value.to_string()));
        self
    }
}

// Bug: builder methods are ignored - no warning!
let request = RequestBuilder::new("https://api.example.com");
request.timeout(Duration::from_secs(30));  // Dropped silently!
request.header("Authorization", "Bearer token");  // Dropped silently!
let response = request.send();  // Sends with no timeout or headers
```

## Good

```rust
struct RequestBuilder {
    url: String,
    timeout: Option<Duration>,
    headers: Vec<(String, String)>,
}

impl RequestBuilder {
    #[must_use = "builder methods return modified builder - chain or assign"]
    fn timeout(mut self, duration: Duration) -> Self {
        self.timeout = Some(duration);
        self
    }
    
    #[must_use = "builder methods return modified builder - chain or assign"]
    fn header(mut self, key: &str, value: &str) -> Self {
        self.headers.push((key.to_string(), value.to_string()));
        self
    }
}

// Now warns: unused return value that must be used
let request = RequestBuilder::new("https://api.example.com");
request.timeout(Duration::from_secs(30));  // Warning!

// Correct: chain methods
let response = RequestBuilder::new("https://api.example.com")
    .timeout(Duration::from_secs(30))
    .header("Authorization", "Bearer token")
    .send();
```

## Apply to Entire Type

```rust
#[must_use = "builders do nothing unless consumed"]
struct ConfigBuilder {
    log_level: Level,
    max_connections: usize,
}

// Now all methods returning Self warn if ignored
impl ConfigBuilder {
    fn log_level(mut self, level: Level) -> Self {
        self.log_level = level;
        self
    }
    
    fn max_connections(mut self, n: usize) -> Self {
        self.max_connections = n;
        self
    }
    
    fn build(self) -> Config {
        Config {
            log_level: self.log_level,
            max_connections: self.max_connections,
        }
    }
}
```

## Message Guidelines

```rust
// Descriptive message helps users understand
#[must_use = "builder methods return modified builder"]
fn with_foo(self, foo: Foo) -> Self { ... }

#[must_use = "this creates a new String and does not modify the original"]
fn to_uppercase(&self) -> String { ... }

#[must_use = "iterator adaptors are lazy - use .collect() to consume"]
fn map<F>(self, f: F) -> Map<Self, F> { ... }
```

## Clippy Lint

```toml
[lints.clippy]
must_use_candidate = "warn"  # Suggests where #[must_use] would help
return_self_not_must_use = "warn"  # Specifically for -> Self methods
```

## Standard Library Examples

```rust
// std::Option - must_use on map, and, or
let x: Option<i32> = Some(5);
x.map(|v| v * 2);  // Warning: unused return value

// std::Result - must_use on the type itself
#[must_use = "this `Result` may be an `Err` variant, which should be handled"]
pub enum Result<T, E> { ... }

// Iterator adaptors
let v = vec![1, 2, 3];
v.iter().map(|x| x * 2);  // Warning: iterators are lazy
```

## See Also

- [api-builder-pattern](./api-builder-pattern.md) - Builder pattern best practices
- [api-must-use](./api-must-use.md) - General must_use guidelines
- [err-result-over-panic](./err-result-over-panic.md) - Result types are must_use
