# pat-if-let-chains

> Use `if let` chains to combine pattern bindings and conditions

## Why It Matters

If-let chains (stabilized in Rust 1.88 under the 2024 edition) let you write a single `if` header that binds multiple patterns and tests arbitrary boolean conditions, all with `&&`. Without chains, each additional binding requires another level of nesting, pushing the happy-path body further right and forcing the reader to track multiple scopes. With chains, all preconditions read left-to-right at the same indentation level.

## Prerequisite

If-let chains require the **2024 edition**. Set it in `Cargo.toml`:

```toml
[package]
edition = "2024"
```

## Bad

```rust
fn handle(input: Option<String>, limit: Option<u32>) -> Option<String> {
    if let Some(s) = input {
        if let Ok(n) = s.trim().parse::<u32>() {
            if let Some(max) = limit {
                if n <= max {
                    return Some(format!("valid: {n}"));
                }
            }
        }
    }
    None
}
```

## Good

```rust
fn handle(input: Option<String>, limit: Option<u32>) -> Option<String> {
    if let Some(s) = input
        && let Ok(n) = s.trim().parse::<u32>()
        && let Some(max) = limit
        && n <= max
    {
        return Some(format!("valid: {n}"));
    }
    None
}
```

Each `&&` clause is evaluated in order; short-circuit semantics still apply, so later clauses only run if earlier ones succeed.

## Mixing Patterns and Boolean Guards

Chains can freely interleave `let` bindings with plain boolean expressions:

```rust
struct Config {
    debug: bool,
    timeout: Option<u64>,
}

fn effective_timeout(cfg: &Config) -> Option<u64> {
    if cfg.debug
        && let Some(t) = cfg.timeout
        && t > 0
    {
        Some(t)
    } else {
        None
    }
}
```

## When to Prefer `let ... else`

Use `let ... else` when the goal is early return on failure; use if-let chains when you have a richer condition that combines multiple optional bindings with a positive body to execute.

## See Also

- [pat-let-else](pat-let-else.md) - early-return pattern extraction without nesting
- [pat-matches-macro](pat-matches-macro.md) - boolean pattern tests with `matches!()`
