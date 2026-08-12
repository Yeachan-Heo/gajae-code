# name-crate-no-rs

> Don't suffix crate names with `-rs` or `-rust`

## Why It Matters

Adding `-rs` or `-rust` to crate names is redundant—you're already on crates.io, it's obviously Rust. These suffixes waste characters, clutter the namespace, and can make crate names harder to type. The Rust community discourages this pattern.

## Bad

```toml
# Cargo.toml
[package]
name = "json-parser-rs"    # Redundant -rs
name = "my-lib-rust"       # Redundant -rust
name = "http-client-rs"    # We know it's Rust
name = "rust-sqlite"       # rust- prefix equally bad
```

## Good

```toml
# Cargo.toml
[package]
name = "json-parser"
name = "my-lib"
name = "http-client"
name = "sqlite-wrapper"

# Real crate examples (no -rs):
# serde (not serde-rs)
# tokio (not tokio-rs)
# reqwest (not reqwest-rs)
# clap (not clap-rs)
```

## When Context Is Needed

```toml
# If you're porting a library from another language:
name = "python-ast"        # Describes what it's for, not what it's written in

# If you're providing bindings:
name = "openssl"           # The Rust crate IS the Rust interface

# Platform-specific:
name = "windows-sys"       # Platform, not language
```

## Repository Naming

```
# GitHub repos don't need -rs either
github.com/user/my-library      # Good
github.com/user/my-library-rs   # Unnecessary

# Though some do for disambiguation from other language versions
github.com/rust-lang/rust       # The rust repo itself uses "rust"
```

## Exceptions

```toml
# Rare cases where disambiguation matters:
# - If there's a widely-known non-Rust project with the same name
# - Official Rust project repositories (rust-lang org)

# But even then, consider alternatives:
name = "fancy-lib"           # Instead of fancy-rs
name = "better-json"         # Instead of json-rust
name = "my-serde-impl"       # Instead of serde-rs-fork
```

## See Also

- [proj-workspace-deps](./proj-workspace-deps.md) - Cargo configuration
- [doc-cargo-metadata](./doc-cargo-metadata.md) - Package metadata
- [name-funcs-snake](./name-funcs-snake.md) - Naming conventions
