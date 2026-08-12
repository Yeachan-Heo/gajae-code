# lint-rustfmt-check

> Run cargo fmt --check in CI

## Why It Matters

Consistent formatting eliminates style debates and makes diffs cleaner. Running `cargo fmt --check` in CI ensures all code follows the same format. This catches formatting issues before merge, not after.

## CI Configuration

### GitHub Actions

```yaml
name: CI

on: [push, pull_request]

jobs:
  fmt:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt
      - run: cargo fmt --all --check
```

### GitLab CI

```yaml
fmt:
  image: rust:latest
  script:
    - rustup component add rustfmt
    - cargo fmt --all --check
```

### Pre-commit Hook

```bash
#!/bin/sh
# .git/hooks/pre-commit
cargo fmt --all --check
```

## Configuration

Create `rustfmt.toml` for custom settings:

```toml
# rustfmt.toml
edition = "2021"
max_width = 100
use_small_heuristics = "Max"
imports_granularity = "Module"
group_imports = "StdExternalCrate"
reorder_imports = true
```

## Common Options

| Option | Default | Description |
|--------|---------|-------------|
| `max_width` | 100 | Maximum line width |
| `tab_spaces` | 4 | Spaces per indent |
| `edition` | "2015" | Rust edition |
| `use_small_heuristics` | "Default" | Layout heuristics |
| `imports_granularity` | "Preserve" | Import grouping |
| `group_imports` | "Preserve" | Import ordering |

## Running Locally

```bash
# Check formatting (doesn't modify files)
cargo fmt --all --check

# Apply formatting
cargo fmt --all

# Format specific file
cargo fmt -- src/main.rs

# Check with verbose output
cargo fmt --all --check -- --verbose
```

## Workspace Formatting

```bash
# Format all workspace members
cargo fmt --all

# Format specific package
cargo fmt -p my-package
```

## Ignoring Files

In `rustfmt.toml`:

```toml
# Skip generated files
ignore = [
    "src/generated/*",
    "build.rs",
]
```

Or in code:

```rust
#[rustfmt::skip]
mod generated_code;

#[rustfmt::skip]
const MATRIX: [[i32; 4]; 4] = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
];
```

## Nightly Features

Some options require nightly:

```toml
# rustfmt.toml (nightly only)
unstable_features = true
imports_granularity = "Crate"
wrap_comments = true
format_code_in_doc_comments = true
```

```bash
# Use nightly rustfmt
cargo +nightly fmt
```

## IDE Integration

Most IDEs format on save. Configure to use project `rustfmt.toml`:

```json
// VS Code settings.json
{
  "rust-analyzer.rustfmt.extraArgs": ["--config-path", "./rustfmt.toml"]
}
```

## See Also

- [lint-warn-style](./lint-warn-style.md) - Style lints
- [lint-pedantic-selective](./lint-pedantic-selective.md) - Pedantic lints
- [name-funcs-snake](./name-funcs-snake.md) - Naming conventions
