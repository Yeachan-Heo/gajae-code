# lint-deny-correctness

> `#![deny(clippy::correctness)]`

## Why It Matters

Clippy's correctness lints catch code that is outright wrong - logic errors, undefined behavior, or code that doesn't do what you think. These should always be errors, not warnings.

## Setup

```rust
// At the top of lib.rs or main.rs
#![deny(clippy::correctness)]

// Or in Cargo.toml for workspace-wide
[lints.clippy]
correctness = "deny"
```

## What It Catches

```rust
// Infinite loop (iter::repeat without take)
for x in std::iter::repeat(1) {  // ERROR: infinite iterator
    println!("{}", x);
}

// Comparison to NaN (always false)
if x == f64::NAN {  // ERROR: NaN != NaN always
    // This never executes
}

// Use after free patterns
let r;
{
    let x = 5;
    r = &x;  // ERROR: x dropped here
}
println!("{}", r);

// Wrong equality check
if x = 5 {  // ERROR: assignment in condition (should be ==)
}

// Useless comparisons
if x >= 0 && x < 0 {  // ERROR: impossible condition
}
```

## Important Correctness Lints

```rust
// approx_constant - using imprecise PI, E values
let pi = 3.14;  // Use std::f64::consts::PI

// invalid_regex - regex that won't compile
let re = Regex::new("[");  // Invalid regex

// iter_next_loop - using .next() in for loop incorrectly
for x in iter.next() {  // Should be: for x in iter

// never_loop - loop that never actually loops
loop {
    break;  // Always breaks immediately
}

// nonsensical_open_options - impossible file options
File::options().read(false).write(false).open("f");

// unit_cmp - comparing unit type ()
if foo() == bar() { }  // Both return (), always true
```

## Full Recommended Lints

```rust
#![deny(clippy::correctness)]
#![warn(clippy::suspicious)]
#![warn(clippy::style)]
#![warn(clippy::complexity)]
#![warn(clippy::perf)]

// For published crates
#![warn(missing_docs)]
#![warn(clippy::cargo)]
```

## Running Clippy

```bash
# Basic check
cargo clippy

# With all warnings as errors
cargo clippy -- -D warnings

# Check specific lint category
cargo clippy -- -W clippy::correctness

# In CI (fail on warnings)
cargo clippy -- -D warnings -D clippy::correctness
```

## See Also

- [lint-warn-suspicious](lint-warn-suspicious.md) - Warn on suspicious code
- [lint-warn-perf](lint-warn-perf.md) - Warn on performance issues
