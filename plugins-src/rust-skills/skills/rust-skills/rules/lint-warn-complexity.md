# lint-warn-complexity

> Enable clippy::complexity for simpler code

## Why It Matters

The `clippy::complexity` lint group identifies unnecessarily complex code that can be simplified. Complex code is harder to read, maintain, and often hides bugs. Clippy suggests cleaner alternatives.

## Configuration

```rust
// In lib.rs or main.rs
#![warn(clippy::complexity)]
```

Or in `Cargo.toml`:

```toml
[lints.clippy]
complexity = "warn"
```

## What It Catches

### Unnecessary Complexity

```rust
// WARN: Overly complex boolean expression
if !(x == 0) { }  // Use: if x != 0 { }

// WARN: Manual implementation of Option::map
match option {
    Some(x) => Some(x + 1),
    None => None,
}  // Use: option.map(|x| x + 1)

// WARN: Unnecessary filter before count
iter.filter(|x| predicate(x)).count()  // Could simplify if only counting
```

### Redundant Operations

```rust
// WARN: Redundant allocation
let s = format!("literal");  // Use: "literal".to_string() or just "literal"

// WARN: Unnecessarily complicated match
match result {
    Ok(ok) => Ok(ok),
    Err(err) => Err(err),
}  // Just use: result

// WARN: Box::new in return position
fn make_error() -> Box<dyn Error> {
    Box::new(MyError)  // Could use: MyError.into()
}
```

### Overly Verbose Code

```rust
// WARN: bind_instead_of_map
option.and_then(|x| Some(x + 1))  // Use: option.map(|x| x + 1)

// WARN: clone_on_copy
let y = x.clone();  // Where x is Copy type, just use: let y = x;

// WARN: useless_let_if_seq
let result;
if condition {
    result = 1;
} else {
    result = 2;
}
// Use: let result = if condition { 1 } else { 2 };
```

## Notable Lints in This Group

| Lint | Simplification |
|------|---------------|
| `bind_instead_of_map` | Use `map` instead of `and_then(Some(...))` |
| `bool_comparison` | `if x == true` → `if x` |
| `clone_on_copy` | Remove `.clone()` for Copy types |
| `filter_next` | Use `.find()` instead |
| `option_map_unit_fn` | Use `if let` instead |
| `search_is_some` | Use `.any()` or `.contains()` |
| `unnecessary_cast` | Remove redundant casts |
| `useless_conversion` | Remove `.into()` when types match |

## Examples

```rust
// Before (complexity warnings)
fn find_positive(nums: &[i32]) -> Option<i32> {
    let filtered: Vec<_> = nums.iter()
        .cloned()
        .filter(|x| *x > 0)
        .collect();
    if filtered.len() == 0 {
        None
    } else {
        Some(filtered[0])
    }
}

// After (simplified)
fn find_positive(nums: &[i32]) -> Option<i32> {
    nums.iter()
        .copied()
        .find(|&x| x > 0)
}
```

## Cognitive Load

Complex code isn't just longer—it's harder to understand:

```rust
// High cognitive load
let value = if x.is_some() { x.unwrap() } else { y.unwrap_or(z) };

// Lower cognitive load
let value = x.unwrap_or_else(|| y.unwrap_or(z));
```

## See Also

- [lint-warn-style](./lint-warn-style.md) - Style warnings
- [lint-warn-perf](./lint-warn-perf.md) - Performance warnings
- [lint-pedantic-selective](./lint-pedantic-selective.md) - Pedantic lints
