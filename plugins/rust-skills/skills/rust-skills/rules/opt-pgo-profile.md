# opt-pgo-profile

> Use Profile-Guided Optimization (PGO) for maximum performance

## Why It Matters

PGO uses real runtime behavior to guide compiler optimization decisions. By profiling actual workloads, the compiler learns which code paths are hot, optimizing them aggressively while deprioritizing cold paths. This can yield 10-30% performance improvements beyond standard optimizations.

## The PGO Process

1. **Instrument**: Build with profiling instrumentation
2. **Profile**: Run representative workloads
3. **Optimize**: Rebuild using collected profile data

## Step-by-Step

```bash
# Step 1: Build instrumented binary
RUSTFLAGS="-Cprofile-generate=/tmp/pgo-data" \
    cargo build --release

# Step 2: Run representative workloads
./target/release/my_app < test_data_1.txt
./target/release/my_app < test_data_2.txt
./target/release/my_app < typical_workload.txt

# Step 3: Merge profile data
llvm-profdata merge -o /tmp/pgo-data/merged.profdata /tmp/pgo-data

# Step 4: Build optimized binary using profile
RUSTFLAGS="-Cprofile-use=/tmp/pgo-data/merged.profdata" \
    cargo build --release
```

## Cargo Configuration

```toml
# Cargo.toml
[profile.release]
lto = "fat"
codegen-units = 1
opt-level = 3

# PGO flags set via RUSTFLAGS environment variable
```

## Build Script

```bash
#!/bin/bash
set -e

PGO_DIR=/tmp/pgo-$(date +%s)

# Clean
cargo clean

# Instrumented build
echo "Building instrumented binary..."
RUSTFLAGS="-Cprofile-generate=$PGO_DIR" cargo build --release

# Run workloads
echo "Collecting profile data..."
./target/release/my_app --benchmark-mode
./target/release/my_app < test_fixtures/typical.txt
./target/release/my_app < test_fixtures/stress.txt

# Merge profiles
echo "Merging profile data..."
llvm-profdata merge -o $PGO_DIR/merged.profdata $PGO_DIR

# Optimized build
echo "Building optimized binary..."
RUSTFLAGS="-Cprofile-use=$PGO_DIR/merged.profdata" cargo build --release

echo "Done! Optimized binary at target/release/my_app"
```

## Representative Workloads

```rust
// Create benchmarks that match real usage patterns

// Good: actual data samples
fn profile_workload() {
    for file in real_customer_data_samples() {
        process_file(&file);
    }
}

// Good: synthetic but realistic
fn profile_synthetic() {
    for _ in 0..10000 {
        let data = generate_realistic_data();
        process(&data);
    }
}

// Bad: artificial microbenchmarks
fn profile_bad() {
    for _ in 0..1000000 {
        small_operation();  // Doesn't reflect real hot paths
    }
}
```

## BOLT Post-Link Optimization

For even more gains, combine PGO with BOLT:

```bash
# After PGO build, apply BOLT
llvm-bolt target/release/my_app \
    -o target/release/my_app.bolt \
    -data=perf.data \
    -reorder-blocks=ext-tsp \
    -reorder-functions=hfsort

# BOLT can add another 5-15% on top of PGO
```

## CI/CD Integration

```yaml
# GitHub Actions example
jobs:
  pgo-build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      
      - name: Install LLVM tools
        run: sudo apt-get install llvm
      
      - name: Instrumented build
        run: RUSTFLAGS="-Cprofile-generate=/tmp/pgo" cargo build --release
      
      - name: Run profiling workloads
        run: ./scripts/run_profiling_workloads.sh
      
      - name: Merge profiles
        run: llvm-profdata merge -o /tmp/pgo/merged.profdata /tmp/pgo
      
      - name: Optimized build
        run: RUSTFLAGS="-Cprofile-use=/tmp/pgo/merged.profdata" cargo build --release
      
      - name: Upload artifact
        uses: actions/upload-artifact@v4
        with:
          name: optimized-binary
          path: target/release/my_app
```

## When to Use PGO

| Use PGO | Skip PGO |
|---------|----------|
| Production deployments | Development builds |
| Performance-critical apps | Libraries (users can PGO) |
| Stable workload patterns | Highly variable workloads |
| Sufficient profiling data | Quick iteration cycles |

## See Also

- [opt-lto-release](./opt-lto-release.md) - LTO works well with PGO
- [opt-codegen-units](./opt-codegen-units.md) - Single codegen unit for PGO
- [perf-profile-first](./perf-profile-first.md) - Profiling basics
