# pat-let-else

> Use `let ... else` for early-return pattern extraction

## Why It Matters

`let ... else` (stable since Rust 1.65) binds a pattern in the success path or diverges in the `else` branch. It keeps the happy path at the top indentation level and eliminates rightward drift that accumulates when nesting multiple `if let` blocks. The `else` block must diverge via `return`, `continue`, `break`, or a macro like `panic!` or `bail!`.

## Bad

```rust
fn process(input: Option<String>) -> Option<u32> {
    if let Some(s) = input {
        if let Ok(n) = s.trim().parse::<u32>() {
            if n > 0 {
                return Some(n * 2);
            } else {
                return None;
            }
        } else {
            return None;
        }
    } else {
        return None;
    }
}
```

## Good

```rust
fn process(input: Option<String>) -> Option<u32> {
    let Some(s) = input else { return None; };
    let Ok(n) = s.trim().parse::<u32>() else { return None; };
    if n == 0 {
        return None;
    }
    Some(n * 2)
}
```

Multiple extractions stay flat, each guarding against one failure mode before the next line runs.

## Using with `anyhow` / `bail!`

The `else` block can use any diverging expression, including macros:

```rust
use anyhow::{bail, Result};

fn get_id(map: &std::collections::HashMap<String, u64>, key: &str) -> Result<u64> {
    let Some(&id) = map.get(key) else {
        bail!("key '{}' not found", key);
    };
    Ok(id)
}
```

## Notes

- The bound variable is in scope **after** the `let` statement, not inside the `else` block.
- Prefer `?` when the `else` branch would just propagate an error; `let ... else` shines when the divergence is a `return`, `continue`, or `break`.
- Clippy lint `clippy::manual_let_else` flags patterns that can be converted.

## See Also

- [err-question-mark](err-question-mark.md) - use `?` for error propagation
- [anti-unwrap-abuse](anti-unwrap-abuse.md) - avoid `.unwrap()` in production code
- [pat-exhaustive-enum](pat-exhaustive-enum.md) - match enums exhaustively
