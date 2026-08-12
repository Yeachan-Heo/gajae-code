# obs-error-chain

> Log errors with their full source chain, and log each error exactly once

## Why It Matters

Logging only the top-level `Display` of an error silently drops the underlying cause chain — you see "request failed" but not *why*. The two common fixes are: use `?` format (`error = ?err`) to capture `Debug` output including the chain, or use `{:#}` on an `anyhow::Error` which formats the full cause chain. The second hazard is the log-and-return anti-pattern: logging the error at every propagation layer records the same failure multiple times with different amounts of context, polluting aggregators. Log once, at the boundary that *handles* the error; everywhere else, propagate with `?` and optionally add context.

## Bad

```rust
use tracing::error;

async fn fetch_data(id: u64) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let data = read_from_db(id).await.map_err(|e| {
        error!("{}", e);  // BAD: drops source chain, logs too early
        e
    })?;
    Ok(data)
}

async fn handle(id: u64) -> Result<(), Box<dyn std::error::Error>> {
    let data = fetch_data(id).await.map_err(|e| {
        error!("{}", e);  // BAD: logged again at every layer
        e
    })?;
    process(data);
    Ok(())
}

async fn read_from_db(_id: u64) -> Result<Vec<u8>, std::io::Error> {
    Err(std::io::Error::other("connection refused"))
}
fn process(_data: Vec<u8>) {}
```

## Good

```rust
use anyhow::{Context, Result};
use tracing::{error, instrument, warn};

// Propagate with context; do NOT log here
#[instrument]
async fn read_from_db(id: u64) -> Result<Vec<u8>> {
    inner_db_call(id)
        .await
        .with_context(|| format!("failed to read record {id} from database"))
    // No logging — just add context and propagate
}

// Also just propagates
#[instrument]
async fn fetch_data(id: u64) -> Result<Vec<u8>> {
    read_from_db(id).await.context("fetch_data failed")
}

// The handler boundary: this is where the error is HANDLED, so log it once
#[instrument]
async fn handle_request(id: u64) -> Result<(), String> {
    match fetch_data(id).await {
        Ok(data) => {
            process(data);
            Ok(())
        }
        Err(err) => {
            // {:#} on anyhow::Error prints the full cause chain
            error!(error = %format!("{err:#}"), "request failed");
            Err("internal error".to_string())
        }
    }
}

async fn inner_db_call(_id: u64) -> Result<Vec<u8>> {
    Err(anyhow::anyhow!("connection refused"))
}
fn process(_data: Vec<u8>) {}
```

## Key Points

- **`error = ?err`**: uses `Debug` — prints the error and its `source()` chain for types that implement it.
- **`format!("{err:#}")`** or `%format!(...)`: `anyhow::Error`'s alternate Display walks the full chain with `: ` separators.
- **Propagate, don't log**: use `?` and `.context()` / `.with_context()` at intermediate layers; log at the single handling boundary.
- If you *must* log at a non-handling layer (e.g., background task that discards the error), use `warn!` not `error!` to signal it was absorbed.
- The `tracing-error` crate provides `SpanTrace` to capture the span context at the error site and attach it to the error type.

## See Also

- [err-context-chain](err-context-chain.md) - add context with `.context()` / `.with_context()`
- [err-source-chain](err-source-chain.md) - chain underlying errors with `#[source]`
- [anti-empty-catch](anti-empty-catch.md) - avoid silently swallowing errors
