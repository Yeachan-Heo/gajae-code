# opt-lto-release

> Enable LTO in release builds

## Why It Matters

Link-Time Optimization (LTO) enables optimizations across crate boundaries that aren't possible during normal compilation. This includes cross-crate inlining, dead code elimination, and devirtualization. Typically provides 5-20% performance improvement.

## Bad

```toml
# Cargo.toml - default release profile
[profile.release]
opt-level = 3
# No LTO = missed optimization opportunities
```

## Good

```toml
# Cargo.toml - optimized release profile
[profile.release]
opt-level = 3
lto = "fat"          # Maximum optimization
codegen-units = 1    # Better optimization (single codegen unit)
panic = "abort"      # Smaller binary, no unwind tables
strip = true         # Remove symbols for smaller binary
```

## LTO Options Explained

```toml
# No LTO (default)
lto = false

# Thin LTO - fast compilation, most benefits
lto = "thin"

# Fat LTO - slowest compilation, maximum optimization
lto = "fat"
# Equivalent to:
lto = true

# Thin-local - LTO within each crate only
lto = "off"
```

## Trade-offs

| Setting | Compile Time | Binary Size | Performance |
|---------|--------------|-------------|-------------|
| `lto = false` | Fast | Larger | Baseline |
| `lto = "thin"` | Medium | Smaller | +5-15% |
| `lto = "fat"` | Slow | Smallest | +10-20% |

## Evidence from Production

Many production crates enable fat LTO and `codegen-units = 1` in their release
profiles for maximum performance. For example, ripgrep ships a `release-lto`
profile (see the Cargo Book for profile documentation:
<https://doc.rust-lang.org/cargo/reference/profiles.html>):

```toml
# A common pattern in performance-critical crates
[profile.release]
overflow-checks = true
lto = "fat"
codegen-units = 1

# Named profile for explicit LTO builds (e.g. ripgrep's release-lto)
[profile.release-lto]
inherits = "release"
opt-level = 3
lto = "fat"
codegen-units = 1
panic = "abort"
strip = "symbols"
```

## Complete Optimized Profile

```toml
[profile.release]
opt-level = 3        # Maximum optimization
lto = "fat"          # Link-time optimization
codegen-units = 1    # Single codegen unit for better optimization
panic = "abort"      # Remove panic unwinding code
strip = true         # Strip symbols
debug = false        # No debug info

# For benchmarking (need some debug info for profiling)
[profile.bench]
inherits = "release"
debug = true
strip = false

# Fast dev builds with optimized dependencies
[profile.dev]
opt-level = 0
debug = true

[profile.dev.package."*"]
opt-level = 3        # Optimize dependencies even in dev
```

## When to Use Each

| Situation | LTO Setting |
|-----------|-------------|
| Development | `false` (fast compiles) |
| CI builds | `"thin"` (balance) |
| Release binaries | `"fat"` (max perf) |
| Libraries (crates.io) | `false` (users choose) |

## Measuring Impact

```bash
# Build without LTO
cargo build --release
hyperfine ./target/release/myapp

# Build with LTO
# (after adding lto = "fat" to Cargo.toml)
cargo build --release
hyperfine ./target/release/myapp

# Compare binary sizes
ls -la target/release/myapp
```

## See Also

- [opt-codegen-units](opt-codegen-units.md) - Use codegen-units = 1
- [opt-pgo-profile](opt-pgo-profile.md) - Profile-guided optimization
- [perf-release-profile](perf-release-profile.md) - Full release profile settings
