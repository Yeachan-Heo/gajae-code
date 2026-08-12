# perf-release-profile

> Optimize release profile settings

## Why It Matters

The default release profile prioritizes compile speed over runtime performance. For production binaries, tuning the release profile can yield significant performance improvements (10-40% in some cases) at the cost of longer compile times.

## Default Profile

```toml
[profile.release]
opt-level = 3
debug = false
lto = false
codegen-units = 16
```

## Optimized Profile

```toml
[profile.release]
opt-level = 3          # Maximum optimization
lto = "fat"            # Full link-time optimization
codegen-units = 1      # Better optimization, slower compile
panic = "abort"        # Smaller binary, no unwinding
strip = true           # Remove symbols

[profile.release.package."*"]
# Keep dependencies optimized even if main crate changes
opt-level = 3
```

## Profile Options

| Option | Values | Effect |
|--------|--------|--------|
| `opt-level` | 0-3, "s", "z" | Optimization level |
| `lto` | false, "thin", "fat" | Link-time optimization |
| `codegen-units` | 1-256 | Parallel compilation units |
| `panic` | "unwind", "abort" | Panic behavior |
| `strip` | true, false, "symbols", "debuginfo" | Binary stripping |
| `debug` | true, false, 0-2 | Debug info level |

## Optimization Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `0` | No optimization | Debug builds |
| `1` | Basic optimization | Fast compile |
| `2` | Most optimizations | Balanced |
| `3` | All optimizations | Maximum performance |
| `"s"` | Optimize for size | Embedded |
| `"z"` | Minimize size | Smallest binary |

## LTO Options

| Option | Compile Time | Performance | Binary Size |
|--------|--------------|-------------|-------------|
| `false` | Fast | Baseline | Larger |
| `"thin"` | Medium | Good | Smaller |
| `"fat"` | Slow | Best | Smallest |

## Custom Profiles

```toml
# Fast release builds for development
[profile.release-dev]
inherits = "release"
lto = false
codegen-units = 16

# Maximum performance for production
[profile.release-prod]
inherits = "release"
lto = "fat"
codegen-units = 1
strip = true

# Profiling with symbols
[profile.profiling]
inherits = "release"
debug = true
strip = false
```

Use with: `cargo build --profile release-prod`

## Dev Dependencies Optimization

Speed up tests and dev builds:

```toml
[profile.dev]
opt-level = 0

# Optimize dependencies even in dev
[profile.dev.package."*"]
opt-level = 3
```

## Benchmarking Profile

```toml
[profile.bench]
inherits = "release"
debug = true      # For profiling
strip = false     # Keep symbols for flamegraphs
lto = "fat"       # Consistent with release-prod
```

## Size vs Speed Trade-offs

```toml
# Smallest binary
[profile.min-size]
inherits = "release"
opt-level = "z"
lto = "fat"
codegen-units = 1
panic = "abort"
strip = true

# Balance size and speed
[profile.balanced]
inherits = "release"
opt-level = "s"
lto = "thin"
```

## Workspace Configuration

```toml
# In workspace Cargo.toml
[profile.release]
lto = "fat"
codegen-units = 1

# Override for specific package
[profile.release.package.fast-compile-lib]
lto = false
codegen-units = 16
```

## See Also

- [opt-lto-release](./opt-lto-release.md) - LTO details
- [opt-codegen-units](./opt-codegen-units.md) - Codegen units
- [opt-pgo-profile](./opt-pgo-profile.md) - Profile-guided optimization
