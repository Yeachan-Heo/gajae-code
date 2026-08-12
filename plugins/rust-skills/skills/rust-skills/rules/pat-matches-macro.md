# pat-matches-macro

> Use `matches!()` for boolean pattern tests

## Why It Matters

`matches!(value, Pattern)` is the idiomatic way to ask "does this value match a pattern?" in a boolean context. Spelling it out as a `match` that returns `true`/`false` is noisy and distracts the reader from the intent. Clippy flags the verbose form with `clippy::match_like_matches_macro`. The macro also supports optional guards, making it useful for range checks and filtered option tests without introducing a binding.

## Bad

```rust
enum Status {
    Active,
    Pending,
    Closed,
}

fn is_active(s: &Status) -> bool {
    match s {
        Status::Active => true,
        _ => false,
    }
}

fn is_small_digit(n: u32) -> bool {
    match n {
        1..=9 => true,
        _ => false,
    }
}

fn is_positive(opt: Option<i32>) -> bool {
    match opt {
        Some(v) if v > 0 => true,
        _ => false,
    }
}
```

## Good

```rust
enum Status {
    Active,
    Pending,
    Closed,
}

fn is_active(s: &Status) -> bool {
    matches!(s, Status::Active)
}

fn is_small_digit(n: u32) -> bool {
    matches!(n, 1..=9)
}

fn is_positive(opt: Option<i32>) -> bool {
    matches!(opt, Some(v) if v > 0)
}
```

## Combining Multiple Variants

`matches!` accepts alternation with `|`, making multi-variant checks concise:

```rust
fn is_terminal(s: &Status) -> bool {
    matches!(s, Status::Closed | Status::Pending)
}
```

## Good for `is_*` Helper Methods

`matches!` pairs especially well with the `is_`/`has_`/`can_` naming convention for boolean predicate methods:

```rust
impl Status {
    pub fn is_active(&self) -> bool {
        matches!(self, Self::Active)
    }

    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Closed | Self::Pending)
    }
}
```

## Asserting a Match in Tests

For tests, `assert_matches!` (and `debug_assert_matches!`) — stabilized in Rust 1.96 — checks a value against a pattern and panics with the value's `Debug` output on failure, which is more informative than `assert!(matches!(...))`. They are not in the prelude, so import them:

```rust
use std::assert_matches::assert_matches;

let result = parse("42");
assert_matches!(result, Ok(n) if n == 42);
```

## Notes

- Enable `#![warn(clippy::match_like_matches_macro)]` (included in `clippy::style`) to catch existing verbose patterns automatically.
- When you need to bind the matched value or branch on it further, a real `match` or `if let` is still the right tool.

## See Also

- [pat-exhaustive-enum](pat-exhaustive-enum.md) - match enums exhaustively instead of using catch-all arms
- [name-is-has-bool](name-is-has-bool.md) - use `is_`, `has_`, `can_` prefixes for boolean methods
