# anti-empty-catch

> Don't silently ignore errors

## Why It Matters

Empty error handling (`if let Err(_) = ...`, `let _ = result`, `.ok()`) silently discards errors. Failures go unnoticed, bugs hide, and debugging becomes impossible. Every error deserves acknowledgment—even if just logging.

## Bad

```rust
// Silently ignores errors
let _ = write_to_file(data);

// Discards error completely
if let Err(_) = send_notification() {
    // Nothing - error vanishes
}

// Converts Result to Option, losing error info
let value = risky_operation().ok();

// Match with empty arm
match database.save(record) {
    Ok(_) => println!("saved"),
    Err(_) => {}  // Silent failure
}

// Ignored in loop
for item in items {
    let _ = process(item);  // Failures unnoticed
}
```

## Good

```rust
// Log the error
if let Err(e) = write_to_file(data) {
    error!("failed to write file: {}", e);
}

// Propagate if possible
send_notification()?;

// Or handle explicitly
match send_notification() {
    Ok(_) => info!("notification sent"),
    Err(e) => warn!("notification failed: {}", e),
}

// Collect errors in batch operations
let (successes, failures): (Vec<_>, Vec<_>) = items
    .into_iter()
    .map(process)
    .partition(Result::is_ok);

if !failures.is_empty() {
    warn!("{} items failed to process", failures.len());
}

// Explicit documentation when ignoring
// Intentionally ignored: cleanup failure is not critical
let _ = cleanup_temp_file();  // Add comment explaining why
```

## Acceptable Ignoring (Documented)

```rust
// Close errors often ignored, but document it
// INTENTIONAL: TCP close errors are not actionable
let _ = stream.shutdown(Shutdown::Both);

// Mutex poisoning recovery
// INTENTIONAL: We'll reset the state anyway
let guard = mutex.lock().unwrap_or_else(|e| e.into_inner());
```

## Pattern: Collect and Report

```rust
fn process_batch(items: Vec<Item>) -> BatchResult {
    let mut errors = Vec::new();
    
    for item in items {
        if let Err(e) = process_item(&item) {
            errors.push((item.id, e));
        }
    }
    
    if errors.is_empty() {
        BatchResult::AllSucceeded
    } else {
        BatchResult::PartialFailure(errors)
    }
}
```

## Pattern: Best-Effort Operations

```rust
// Metrics/telemetry can fail without affecting main flow
fn report_metric(name: &str, value: f64) {
    if let Err(e) = metrics_client.record(name, value) {
        // Log but don't propagate - metrics are not critical
        debug!("failed to record metric {}: {}", name, e);
    }
}
```

## Clippy Lint

```toml
[lints.clippy]
let_underscore_drop = "warn"
ignored_unit_patterns = "warn"
```

## Decision Guide

| Situation | Action |
|-----------|--------|
| Critical operation | `?` or handle explicitly |
| Non-critical, debugging needed | Log the error |
| Truly ignorable (rare) | `let _ =` with comment |
| Batch operation | Collect errors, report |

## See Also

- [err-result-over-panic](./err-result-over-panic.md) - Proper error handling
- [err-context-chain](./err-context-chain.md) - Adding context
- [anti-unwrap-abuse](./anti-unwrap-abuse.md) - Unwrap issues
