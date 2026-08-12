# proj-bin-dir

> Put multiple binaries in src/bin/

## Why It Matters

When a crate produces multiple binaries, placing them in `src/bin/` keeps the project organized. Each file becomes a separate binary target automatically, without manual `Cargo.toml` configuration.

## Bad

```
my-project/
├── Cargo.toml        # Complex [[bin]] sections for each binary
├── src/
│   ├── main.rs       # Which binary is this?
│   ├── server.rs     # Is this a module or binary?
│   ├── cli.rs        # Unclear
│   └── lib.rs
```

```toml
# Cargo.toml - verbose and error-prone
[[bin]]
name = "server"
path = "src/server.rs"

[[bin]]
name = "cli"
path = "src/cli.rs"
```

## Good

```
my-project/
├── Cargo.toml        # Clean, no [[bin]] needed
├── src/
│   ├── lib.rs        # Shared library code
│   └── bin/
│       ├── server.rs # Binary: my-project-server (or just server)
│       └── cli.rs    # Binary: my-project-cli (or just cli)
```

Each file in `src/bin/` automatically becomes a binary named after the file.

## Running Binaries

```bash
# Run specific binary
cargo run --bin server
cargo run --bin cli

# Build specific binary
cargo build --bin server

# Build all binaries
cargo build --bins
```

## Pattern: Binary with Multiple Files

For complex binaries, use directories:

```
src/
├── lib.rs
└── bin/
    ├── server/
    │   ├── main.rs      # Entry point
    │   ├── config.rs    # Server-specific module
    │   └── handlers.rs
    └── cli/
        ├── main.rs
        └── commands.rs
```

## Pattern: Shared Library Code

```rust
// src/lib.rs - Shared code
pub mod config;
pub mod database;
pub mod models;

// src/bin/server.rs - Server binary
use my_project::{config, database, models};

fn main() {
    let config = config::load();
    let db = database::connect(&config);
    // ...
}

// src/bin/cli.rs - CLI binary
use my_project::{config, models};

fn main() {
    let config = config::load();
    // CLI logic using shared code
}
```

## Binary Naming

| File Path | Binary Name |
|-----------|-------------|
| `src/main.rs` | `my-project` (crate name) |
| `src/bin/server.rs` | `server` |
| `src/bin/my-cli.rs` | `my-cli` |
| `src/bin/server/main.rs` | `server` |

## Explicit Configuration

When you need custom settings:

```toml
[[bin]]
name = "my-server"
path = "src/bin/server.rs"
required-features = ["server"]

[[bin]]
name = "my-cli"
path = "src/bin/cli.rs"
```

## Pattern: Default Binary

```toml
# src/main.rs is the default binary
# Additional binaries in src/bin/

[package]
name = "my-tool"
default-run = "my-tool"  # Or specify another
```

## See Also

- [proj-lib-main-split](./proj-lib-main-split.md) - Keep main.rs minimal
- [proj-workspace-large](./proj-workspace-large.md) - Workspace for larger projects
- [proj-flat-small](./proj-flat-small.md) - Simple project structure
