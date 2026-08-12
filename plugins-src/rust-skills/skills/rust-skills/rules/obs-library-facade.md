# obs-library-facade

> Libraries emit through the tracing/log facade and never install a subscriber

## Why It Matters

Installing a global subscriber or logger is a one-time, process-wide operation. If a library calls `tracing_subscriber::fmt::init()` or `env_logger::init()`, it silently conflicts with any other library or the application binary that does the same — the second call panics or is silently ignored, and the caller loses all control over log format, destination, and level filtering. Libraries must only *emit* events and spans; the binary that owns `main` decides how to handle them. This is the same contract as `log` has always enforced and `tracing` carries forward.

## Bad

```rust
// In a library crate: mylib/src/lib.rs
use tracing::info;

pub fn connect(url: &str) {
    // BAD: library installs a subscriber — conflicts with the application
    tracing_subscriber::fmt::init();
    info!(url, "connecting");
}
```

```rust
// Also bad: using env_logger in a library
pub fn init_logging() {
    env_logger::init(); // steals the global logger from the application
}
```

## Good

```rust
// In a library crate: mylib/src/lib.rs
use tracing::info;

pub fn connect(url: &str) {
    // Good: just emit; the application owns subscriber setup
    info!(url, "connecting");
}
```

```rust
// In the binary: src/main.rs
fn main() {
    // The application initializes once, with full control
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    mylib::connect("postgres://localhost/app");
}
```

## Key Points

- **Library `Cargo.toml`**: depend on `tracing = "0.1"` only. Do **not** add `tracing-subscriber` or `env_logger` as non-`dev` dependencies.
- **Binary `Cargo.toml`**: add `tracing-subscriber = { version = "0.3", features = ["env-filter"] }` for the subscriber.
- If you need a subscriber in library tests, add it to `[dev-dependencies]` and call it inside `#[test]` functions using `tracing_subscriber::fmt::try_init()` (the `try_` variant does not panic on re-init).
- The `log` crate follows the same rule: libraries call `log::info!(...)`; applications call `env_logger::init()` or bridge via `tracing_log::LogTracer`.

```toml
# library Cargo.toml
[dependencies]
tracing = "0.1"

[dev-dependencies]
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
```

## See Also

- [obs-tracing-over-log](obs-tracing-over-log.md) - why to use `tracing` over `println!` or bare `log`
- [obs-levels-filter](obs-levels-filter.md) - configure level filtering with `EnvFilter` in the binary
- [api-serde-optional](api-serde-optional.md) - pattern for gating heavy dependencies behind feature flags
