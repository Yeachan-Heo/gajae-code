# obs-levels-filter

> Use log levels meaningfully and filter with `EnvFilter` / `RUST_LOG`

## Why It Matters

Log levels exist to communicate urgency and to let operators tune verbosity without recompiling. Misusing them — emitting everything at `info!`, or leaving `debug!` output in hot paths in production — overwhelms aggregators and hides real signals. `tracing_subscriber::EnvFilter` reads the `RUST_LOG` environment variable and supports per-crate, per-target, and per-span directives, giving operators fine-grained control at runtime. For release builds, tracing's `max_level_*` Cargo features can compile out verbose levels entirely, eliminating even the call-site overhead.

## Bad

```rust
use tracing::info;

fn handle_request(path: &str, body: &[u8]) {
    // BAD: debug-level detail emitted at info — always noisy in production
    info!(path, body_len = body.len(), raw = ?body, "handling request");
    info!("entered handle_request");         // trace-level lifecycle noise
    info!("about to parse body");            // also trace-level
    // ... actual logic ...
    info!("done handling request");
}
```

## Good

```rust
use tracing::{debug, error, info, instrument, trace, warn};

#[instrument(skip(body))]
fn handle_request(path: &str, body: &[u8]) {
    trace!("entered handler");                          // very verbose — trace
    debug!(body_len = body.len(), "parsing body");      // diagnostic — debug
    info!(path, "request received");                    // lifecycle — info

    match parse_body(body) {
        Ok(parsed) => {
            info!(items = parsed.len(), "request processed");
        }
        Err(e) if is_client_error(&e) => {
            warn!(error = ?e, "malformed request from client");   // recoverable — warn
        }
        Err(e) => {
            error!(error = ?e, "unexpected parse failure");       // needs attention — error
        }
    }
}

fn parse_body(_body: &[u8]) -> Result<Vec<u8>, String> { Ok(vec![]) }
fn is_client_error(_e: &str) -> bool { false }
```

```rust
// In main: configure EnvFilter from RUST_LOG
fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,myapp=debug,hyper=warn".into()),
        )
        .init();
}
```

## Level Guidelines

| Level | Use for | Example |
|---|---|---|
| `error!` | Failures that need immediate attention | database connection lost |
| `warn!` | Recoverable anomalies, degraded state | retrying after timeout |
| `info!` | High-level lifecycle events | server started, request complete |
| `debug!` | Diagnostic detail for development | query parameters, cache status |
| `trace!` | Very verbose, per-iteration detail | loop counters, raw bytes |

## Key Points

- `RUST_LOG=info,mycrate=debug,hyper=warn` — comma-separated target=level pairs; the first token sets the global default.
- Compile out verbose levels in release with Cargo features: `tracing = { version = "0.1", features = ["max_level_debug", "release_max_level_info"] }`.
- Prefer `try_from_default_env()` with a fallback string over `from_default_env()` so the binary still starts when `RUST_LOG` is unset or malformed.

## See Also

- [obs-tracing-over-log](obs-tracing-over-log.md) - foundational `tracing` setup
- [obs-library-facade](obs-library-facade.md) - libraries emit events; binaries configure filtering
