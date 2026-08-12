# proj-workspace-deps

> Use workspace dependency inheritance for consistent versions across crates

## Why It Matters

Multi-crate workspaces often have dependency version drift—different crates using different versions of the same dependency. Workspace dependency inheritance (Rust 1.64+) lets you declare dependencies once in the workspace `Cargo.toml` and inherit them in member crates, ensuring consistency.

## Bad

```toml
# crate-a/Cargo.toml
[dependencies]
serde = "1.0.150"
tokio = "1.25"

# crate-b/Cargo.toml  
[dependencies]
serde = "1.0.188"  # Different version!
tokio = "1.32"     # Different version!

# Version drift leads to:
# - Larger binaries (multiple versions)
# - Compilation time increase
# - Subtle behavior differences
```

## Good

```toml
# Root Cargo.toml
[workspace]
members = ["crate-a", "crate-b", "crate-c"]

[workspace.dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = { version = "1.32", features = ["full"] }
thiserror = "1.0"
anyhow = "1.0"
tracing = "0.1"

# crate-a/Cargo.toml
[dependencies]
serde.workspace = true
tokio.workspace = true

# crate-b/Cargo.toml
[dependencies]
serde.workspace = true
tokio.workspace = true
thiserror.workspace = true
```

## Override Features

```toml
# Root Cargo.toml
[workspace.dependencies]
tokio = { version = "1.32", features = ["rt-multi-thread"] }

# crate-a/Cargo.toml - add extra features
[dependencies]
tokio = { workspace = true, features = ["net", "io-util"] }
# Gets both workspace features AND local features

# crate-b/Cargo.toml - minimal features
[dependencies]
tokio = { workspace = true }  # Just workspace features
```

## Dev and Build Dependencies

```toml
# Root Cargo.toml
[workspace.dependencies]
criterion = "0.5"
proptest = "1.0"
trybuild = "1.0"
cc = "1.0"

# crate-a/Cargo.toml
[dev-dependencies]
criterion.workspace = true
proptest.workspace = true

[build-dependencies]
cc.workspace = true
```

## Internal Crate Dependencies

```toml
# Root Cargo.toml
[workspace.dependencies]
# Internal crates
my-core = { path = "crates/core" }
my-utils = { path = "crates/utils" }
my-derive = { path = "crates/derive" }

# External crates
serde = "1.0"

# crate-a/Cargo.toml
[dependencies]
my-core.workspace = true
my-utils.workspace = true
serde.workspace = true
```

## Optional Dependencies

```toml
# Root Cargo.toml
[workspace.dependencies]
serde = { version = "1.0", optional = true }  # Won't work!

# Optional must be set in member, not workspace
[workspace.dependencies]
serde = "1.0"

# crate-a/Cargo.toml
[dependencies]
serde = { workspace = true, optional = true }

[features]
serde = ["dep:serde"]
```

## Complete Workspace Example

```toml
# Root Cargo.toml
[workspace]
members = ["crates/*"]
resolver = "3"  # default for the 2024 edition; use "2" for 2021

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "MIT"
repository = "https://github.com/user/repo"

[workspace.dependencies]
# Internal
my-core = { path = "crates/core", version = "0.1" }

# Async
tokio = { version = "1.32", features = ["full"] }
futures = "0.3"

# Serialization
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"

# Error handling
thiserror = "1.0"
anyhow = "1.0"

# Logging
tracing = "0.1"
tracing-subscriber = "0.3"

# Testing
proptest = "1.0"
criterion = { version = "0.5", features = ["html_reports"] }

# crates/core/Cargo.toml
[package]
name = "my-core"
version.workspace = true
edition.workspace = true
license.workspace = true

[dependencies]
serde.workspace = true
thiserror.workspace = true

[dev-dependencies]
proptest.workspace = true
```

## See Also

- [proj-lib-main-split](./proj-lib-main-split.md) - Workspace structure
- [api-serde-optional](./api-serde-optional.md) - Optional dependencies
- [lint-deny-correctness](./lint-deny-correctness.md) - Workspace lints
