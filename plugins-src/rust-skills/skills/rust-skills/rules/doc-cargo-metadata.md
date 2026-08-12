# doc-cargo-metadata

> Fill `Cargo.toml` metadata for published crates

## Why It Matters

Cargo.toml metadata appears on crates.io, in search results, and helps users evaluate your crate. Missing metadata makes your crate look unprofessional, harder to find, and harder to trust. Complete metadata improves discoverability and adoption.

## Bad

```toml
[package]
name = "my-awesome-crate"
version = "0.1.0"
edition = "2021"

[dependencies]
# ...
```

## Good

```toml
[package]
name = "my-awesome-crate"
version = "0.1.0"
edition = "2021"
rust-version = "1.70"

# Required for crates.io
description = "A fast, ergonomic HTTP client for Rust"
license = "MIT OR Apache-2.0"
repository = "https://github.com/username/my-awesome-crate"

# Highly recommended
documentation = "https://docs.rs/my-awesome-crate"
readme = "README.md"
keywords = ["http", "client", "async", "networking"]
categories = ["network-programming", "web-programming::http-client"]
authors = ["Your Name <you@example.com>"]
homepage = "https://my-awesome-crate.dev"

# Optional but helpful
include = ["src/**/*", "Cargo.toml", "LICENSE*", "README.md"]
exclude = ["tests/fixtures/*", ".github/*"]

[badges]
maintenance = { status = "actively-developed" }

[dependencies]
# ...
```

## Required Fields for Publishing

| Field | Purpose |
|-------|---------|
| `name` | Crate name on crates.io |
| `version` | Semver version |
| `license` or `license-file` | SPDX license identifier |
| `description` | One-line summary (≤256 chars) |

## Recommended Fields

| Field | Purpose | Example |
|-------|---------|---------|
| `repository` | Link to source code | `https://github.com/user/repo` |
| `documentation` | Link to docs | `https://docs.rs/crate` |
| `readme` | Path to README | `README.md` |
| `keywords` | Search terms (max 5) | `["http", "async"]` |
| `categories` | crates.io categories | `["network-programming"]` |
| `rust-version` | MSRV | `"1.70"` |

## Keywords Best Practices

```toml
# Good: specific, searchable terms
keywords = ["json", "serialization", "serde", "parsing"]

# Bad: too generic or redundant
keywords = ["rust", "library", "awesome", "fast", "best"]
```

## Categories

Choose from [crates.io categories](https://crates.io/category_slugs):

```toml
categories = [
    "network-programming",
    "web-programming::http-client",
    "asynchronous",
]
```

## License Patterns

```toml
# Single license
license = "MIT"

# Dual license (common in Rust ecosystem)
license = "MIT OR Apache-2.0"

# Custom license file
license-file = "LICENSE"
```

## Include/Exclude

Control what gets published:

```toml
# Explicit include (whitelist)
include = [
    "src/**/*",
    "Cargo.toml",
    "LICENSE*",
    "README.md",
    "CHANGELOG.md",
]

# Or exclude (blacklist)
exclude = [
    "tests/fixtures/large-file.bin",
    ".github/*",
    "benches/*",
]
```

## Verification

Check your package before publishing:

```bash
# See what will be included
cargo package --list

# Check metadata
cargo publish --dry-run
```

## See Also

- [doc-module-inner](./doc-module-inner.md) - Crate-level documentation
- [lint-cargo-metadata](./lint-cargo-metadata.md) - Linting Cargo.toml
- [proj-workspace-deps](./proj-workspace-deps.md) - Workspace management
