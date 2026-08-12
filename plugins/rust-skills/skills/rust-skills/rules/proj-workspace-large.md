# proj-workspace-large

> Use workspaces for large projects

## Why It Matters

Cargo workspaces manage multiple related crates under one repository. They share a single `Cargo.lock`, build cache, and can be versioned together. For large projects, workspaces improve build times, enforce modularity, and simplify dependency management.

## Bad

```
# Separate repositories for each crate
my-app-core/
my-app-cli/
my-app-server/
my-app-common/

# Each has its own Cargo.lock
# Dependencies may drift
# Cross-crate development is painful
```

## Good

```
my-app/
├── Cargo.toml          # Workspace root
├── Cargo.lock          # Shared lock file
├── crates/
│   ├── core/
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── cli/
│   │   ├── Cargo.toml
│   │   └── src/
│   ├── server/
│   │   ├── Cargo.toml
│   │   └── src/
│   └── common/
│       ├── Cargo.toml
│       └── src/
└── README.md
```

## Workspace Cargo.toml

```toml
# Root Cargo.toml
[workspace]
resolver = "3"  # default for the 2024 edition; use "2" for 2021
members = [
    "crates/core",
    "crates/cli",
    "crates/server",
    "crates/common",
]

# Shared dependencies - all crates use same versions
[workspace.dependencies]
tokio = { version = "1.0", features = ["full"] }
serde = { version = "1.0", features = ["derive"] }
tracing = "0.1"
anyhow = "1.0"

# Shared lints
[workspace.lints.rust]
unsafe_code = "forbid"

[workspace.lints.clippy]
all = "warn"
```

## Member Crate Cargo.toml

```toml
# crates/core/Cargo.toml
[package]
name = "my-app-core"
version = "0.1.0"
edition = "2021"

[dependencies]
# Inherit from workspace
tokio = { workspace = true }
serde = { workspace = true }

# Crate-specific dependencies
uuid = "1.0"

# Internal dependency
my-app-common = { path = "../common" }

[lints]
workspace = true  # Inherit workspace lints
```

## When to Use Workspaces

| Scenario | Recommendation |
|----------|----------------|
| Single binary/library | No workspace needed |
| Library + CLI | Maybe, depends on size |
| Multiple related crates | Yes |
| Shared internal libraries | Yes |
| Microservices mono-repo | Yes |
| Plugin architecture | Yes |

## Benefits

| Aspect | Single Crate | Workspace |
|--------|--------------|-----------|
| Build cache | Crate only | Shared across all |
| Dependency versions | Per-crate | Synchronized |
| Compile times | Full rebuild | Incremental |
| Modularity | Files/modules | Crate boundaries |
| Publishing | Single crate | Independent |

## Commands

```bash
# Build all crates
cargo build --workspace

# Build specific crate
cargo build -p my-app-core

# Test all crates
cargo test --workspace

# Run specific binary
cargo run -p my-app-cli

# Check all
cargo check --workspace
```

## Pattern: Virtual Workspace

Root Cargo.toml is workspace-only (no `[package]`):

```toml
[workspace]
members = ["crates/*"]

[workspace.dependencies]
# ...
```

## Pattern: Crate Interdependencies

```toml
# crates/server/Cargo.toml
[dependencies]
my-app-core = { path = "../core" }
my-app-common = { path = "../common" }
```

## See Also

- [proj-workspace-deps](./proj-workspace-deps.md) - Workspace dependencies
- [proj-bin-dir](./proj-bin-dir.md) - Multiple binaries
- [proj-lib-main-split](./proj-lib-main-split.md) - Lib/main separation
