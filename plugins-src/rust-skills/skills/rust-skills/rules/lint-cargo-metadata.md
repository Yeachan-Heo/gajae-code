# lint-cargo-metadata

> Enable clippy::cargo for published crates

## Why It Matters

The `clippy::cargo` lint group checks Cargo.toml for issues that affect publishing and dependency management. For crates intended for crates.io, these checks help ensure a professional, well-configured package.

## Configuration

```toml
# Cargo.toml
[lints.clippy]
cargo = "warn"
```

Or in code:

```rust
#![warn(clippy::cargo)]
```

## What It Catches

### Missing Metadata

```toml
# WARN: missing package.description
# WARN: missing package.license or package.license-file
# WARN: missing package.repository
[package]
name = "my-crate"
version = "0.1.0"
```

### Dependency Issues

```toml
# WARN: feature used but not defined
# WARN: dependency version not specified
[dependencies]
serde = "*"  # Bad: any version
tokio = { git = "..." }  # WARN for published crates
```

### Feature Issues

```toml
# WARN: negative_feature_names
[features]
no-std = []  # Should be: std = [] (opt-out vs opt-in)

# WARN: redundant_feature_names
[features]
default = ["feature-a"]
feature-a = []  # Feature name matches crate name
```

## Notable Lints

| Lint | Issue |
|------|-------|
| `cargo_common_metadata` | Missing description/license/repository |
| `multiple_crate_versions` | Same crate at different versions |
| `negative_feature_names` | Features like `no-std` instead of `std` |
| `redundant_feature_names` | Feature same as crate name |
| `wildcard_dependencies` | Using `*` for version |

## Complete Cargo.toml

```toml
[package]
name = "my-crate"
version = "0.1.0"
edition = "2021"
rust-version = "1.70"

# Required for cargo lint satisfaction
description = "A short description of what this crate does"
license = "MIT OR Apache-2.0"
repository = "https://github.com/user/my-crate"

# Recommended
documentation = "https://docs.rs/my-crate"
readme = "README.md"
keywords = ["keyword1", "keyword2"]
categories = ["category-slug"]

[dependencies]
# Specific versions, not wildcards
serde = "1.0"
tokio = { version = "1.0", features = ["full"] }

[features]
default = ["std"]
std = []  # Opt-out, not no-std opt-in

[lints.clippy]
cargo = "warn"
```

## Multiple Crate Versions

```
# WARN: multiple versions of `syn` in dependency tree
# syn v1.0.109
# syn v2.0.48
```

Fix by updating dependencies or using `[patch]`:

```toml
[patch.crates-io]
old-dep = { git = "...", branch = "syn-2" }
```

## When to Disable

For internal/unpublished crates:

```toml
[lints.clippy]
cargo = "allow"  # Not publishing, metadata not needed
```

Or selectively:

```toml
[lints.clippy]
cargo = "warn"
multiple_crate_versions = "allow"  # Acceptable in this project
```

## See Also

- [doc-cargo-metadata](./doc-cargo-metadata.md) - Cargo.toml metadata
- [proj-workspace-deps](./proj-workspace-deps.md) - Workspace dependencies
- [lint-deny-correctness](./lint-deny-correctness.md) - Correctness lints
