# doc-crate-readme

> Unify the README and crate root docs with `#![doc = include_str!("../README.md")]`

## Why It Matters

Maintaining a `README.md` and a separate crate-level doc comment in `lib.rs` leads to inevitable drift: the README gets updated for GitHub/crates.io visitors while the rustdoc front page grows stale, or vice versa. The `include_str!` attribute macro (stable since Rust 1.54) makes the README the single source of truth for both surfaces. Set `readme = "README.md"` in `Cargo.toml` so crates.io also picks up the same file. The result: one file, three consistent rendering targets — GitHub, crates.io, and docs.rs.

## Bad

```rust
// src/lib.rs — separate doc comment that will drift from README.md
//! # my-crate
//!
//! A library for doing things. (duplicate, will get out of date)
//!
//! ## Usage
//! ...

pub fn do_thing() {}
```

```toml
# Cargo.toml — readme field absent; crates.io shows nothing
[package]
name = "my-crate"
version = "0.1.0"
edition = "2024"
```

## Good

```rust
// src/lib.rs — README is the single source of truth
#![doc = include_str!("../README.md")]

pub fn do_thing() {}
```

```toml
# Cargo.toml
[package]
name = "my-crate"
version = "0.1.0"
edition = "2024"
readme = "README.md"          # crates.io landing page
documentation = "https://docs.rs/my-crate"
```

## Handling Non-Rust Code Blocks in README

When the README contains code blocks that are not valid Rust, rustdoc will try to compile them as doc-tests and fail. Fix this by tagging those blocks:

````markdown
```bash
cargo add my-crate
```

```text
output that should not be compiled
```

```rust,no_run
// example that should be shown but not executed
let x = long_running_operation();
```
````

For TOML or shell blocks already tagged with their language (` ```toml `, ` ```bash `), rustdoc ignores them automatically — no extra annotation needed.

## See Also

- [doc-module-inner](doc-module-inner.md) - use `//!` for module-level documentation
- [doc-cargo-metadata](doc-cargo-metadata.md) - fill Cargo.toml metadata fields
- [doc-all-public](doc-all-public.md) - document all public items with `///`
