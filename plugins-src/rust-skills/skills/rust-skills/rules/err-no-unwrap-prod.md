# err-no-unwrap-prod

> Avoid `unwrap()` in production code; use `?`, `expect()`, or handle errors

## Why It Matters

`unwrap()` panics on `None` or `Err` without any context about what went wrong. In production, this creates cryptic crash messages that are hard to debug. Either propagate errors with `?`, use `expect()` with a message explaining the invariant, or handle the error explicitly.

## Bad

```rust
fn process_request(req: Request) -> Response {
    let user_id = req.headers.get("X-User-Id").unwrap();  // Why did it fail?
    let user = database.find_user(user_id).unwrap();       // Which operation?
    let data = user.preferences.get("theme").unwrap();     // No context
    
    Response::new(data)
}

// Crash message: "called `Option::unwrap()` on a `None` value"
// Where? Why? No idea.
```

## Good

```rust
// Option 1: Propagate with ?
fn process_request(req: Request) -> Result<Response, AppError> {
    let user_id = req.headers
        .get("X-User-Id")
        .ok_or(AppError::MissingHeader("X-User-Id"))?;
    
    let user = database.find_user(user_id)?;
    
    let data = user.preferences
        .get("theme")
        .ok_or(AppError::MissingPreference("theme"))?;
    
    Ok(Response::new(data))
}

// Option 2: expect() for invariants (not user input)
fn get_config_value(&self, key: &str) -> &str {
    self.config
        .get(key)
        .expect("BUG: required config key missing after validation")
}

// Option 3: Provide defaults
fn get_theme(user: &User) -> &str {
    user.preferences
        .get("theme")
        .unwrap_or(&"default")
}

// Option 4: Match for complex handling
fn process_optional(value: Option<Data>) -> ProcessedData {
    match value {
        Some(data) => process(data),
        None => {
            log::warn!("No data provided, using fallback");
            ProcessedData::default()
        }
    }
}
```

## `expect()` vs `unwrap()`

```rust
// Bad: no context
let port = config.get("port").unwrap();

// Better: explains the invariant
let port = config.get("port")
    .expect("config must contain 'port' after validation");

// Best: propagate if it's not truly an invariant
let port = config.get("port")
    .ok_or_else(|| ConfigError::MissingKey("port"))?;
```

## Alternatives to unwrap()

| Situation | Use Instead |
|-----------|-------------|
| Can propagate error | `?` operator |
| Has sensible default | `unwrap_or()`, `unwrap_or_default()` |
| Default requires computation | `unwrap_or_else(\|\| ...)` |
| Internal invariant | `expect("explanation")` |
| Need to handle both cases | `match` or `if let` |

## Clippy Lints

```toml
# Cargo.toml
[lints.clippy]
unwrap_used = "warn"      # Warn on unwrap()
expect_used = "warn"       # Also warn on expect() (stricter)
```

```rust
// Allow in specific places where it's justified
#[allow(clippy::unwrap_used)]
fn definitely_safe() {
    // Unwrap is safe here because...
    let x = Some(5).unwrap();
}
```

## See Also

- [err-result-over-panic](./err-result-over-panic.md) - Return Result instead of panicking
- [err-expect-bugs-only](./err-expect-bugs-only.md) - When expect() is appropriate
- [anti-unwrap-abuse](./anti-unwrap-abuse.md) - Patterns for avoiding unwrap
