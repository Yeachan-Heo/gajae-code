# opt-target-cpu

> Use `target-cpu=native` for maximum performance on known deployment targets

## Why It Matters

By default, Rust compiles for a generic x86-64 baseline (roughly Sandy Bridge era). Modern CPUs have SIMD extensions (AVX2, AVX-512), improved instructions, and micro-architectural optimizations that go unused. `target-cpu=native` enables all features of your current CPU, potentially unlocking significant speedups.

## Bad

```toml
# Cargo.toml - compiles for generic x86-64
[profile.release]
# No target-cpu specified
# Binary works everywhere but uses only SSE2
```

## Good

```toml
# .cargo/config.toml - for known deployment target
[build]
rustflags = ["-C", "target-cpu=native"]

# Or specific CPU for cross-compilation
# rustflags = ["-C", "target-cpu=skylake"]
```

## Via Environment

```bash
# Build with native optimizations
RUSTFLAGS="-C target-cpu=native" cargo build --release

# Check what features are enabled
rustc --print cfg -C target-cpu=native | grep target_feature
```

## Common Target CPUs

```bash
# x86-64 targets
target-cpu=native          # Current machine
target-cpu=x86-64          # Baseline (SSE2)
target-cpu=x86-64-v2       # SSE4.2, POPCNT
target-cpu=x86-64-v3       # AVX2, BMI2
target-cpu=x86-64-v4       # AVX-512

# Intel specific
target-cpu=skylake         # 6th gen Core
target-cpu=alderlake       # 12th gen Core

# AMD specific
target-cpu=znver3          # Zen 3
target-cpu=znver4          # Zen 4

# ARM
target-cpu=apple-m1        # Apple Silicon
target-cpu=neoverse-n1     # AWS Graviton2
```

## Feature Detection at Runtime

```rust
// For portable binaries that use native features when available
#[cfg(target_arch = "x86_64")]
fn process_fast(data: &[u8]) -> u64 {
    if is_x86_feature_detected!("avx2") {
        // SAFETY: only reached after avx2 is detected at runtime
        unsafe { process_avx2(data) }
    } else {
        process_generic(data)
    }
}

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn process_avx2(data: &[u8]) -> u64 {
    // an AVX2-optimized path would go here; delegate to the scalar version
    process_generic(data)
}

fn process_generic(data: &[u8]) -> u64 {
    data.iter().map(|&b| u64::from(b)).sum()
}
```

## Multi-Architecture Builds

```bash
# Build multiple binaries
RUSTFLAGS="-C target-cpu=x86-64" cargo build --release
mv target/release/app target/release/app-generic

RUSTFLAGS="-C target-cpu=x86-64-v3" cargo build --release
mv target/release/app target/release/app-avx2

# Select at runtime
if supports_avx2; then
    ./app-avx2
else
    ./app-generic
fi
```

## Cargo Configuration

```toml
# .cargo/config.toml

# Native builds for development
[target.x86_64-unknown-linux-gnu]
rustflags = ["-C", "target-cpu=native"]

# AWS deployment (Graviton2)
[target.aarch64-unknown-linux-gnu]
rustflags = ["-C", "target-cpu=neoverse-n1"]

# Intel server deployment
[target.x86_64-unknown-linux-gnu.deployment]
rustflags = ["-C", "target-cpu=skylake-avx512"]
```

## What Changes

```rust
// With AVX2 enabled:
// - 256-bit SIMD operations
// - Better autovectorization
// - FMA (fused multiply-add)
// - BMI (bit manipulation)

// Example: sum of squares
fn sum_squares(data: &[f64]) -> f64 {
    data.iter().map(|x| x * x).sum()
}
// Generic: scalar loop
// AVX2: processes 4 f64s per iteration
```

## Checking Enabled Features

```bash
# What's enabled for native?
rustc --print cfg -C target-cpu=native | grep feature

# Compare generic vs native
rustc --print cfg -C target-cpu=x86-64 | grep feature
rustc --print cfg -C target-cpu=native | grep feature

# View generated assembly
cargo asm --rust --release my_crate::hot_function
```

## See Also

- [opt-lto-release](./opt-lto-release.md) - Combine with LTO
- [opt-simd-portable](./opt-simd-portable.md) - Portable SIMD
- [opt-codegen-units](./opt-codegen-units.md) - Single codegen unit
