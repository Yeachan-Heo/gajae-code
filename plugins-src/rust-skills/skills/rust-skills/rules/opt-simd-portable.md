# opt-simd-portable

> Use portable SIMD for vectorized operations across architectures

## Why It Matters

SIMD (Single Instruction, Multiple Data) processes multiple values per instruction—4x, 8x, or more speedup for suitable algorithms. Rust's portable SIMD (nightly) and crates like `wide` provide cross-platform vectorization without architecture-specific intrinsics. For stable Rust, let LLVM auto-vectorize or use platform-specific crates.

## Autovectorization (Stable)

```rust
// LLVM often vectorizes simple patterns automatically
fn sum(data: &[f32]) -> f32 {
    data.iter().sum()  // May vectorize to SIMD
}

fn add_arrays(a: &[f32], b: &[f32], out: &mut [f32]) {
    for ((x, y), o) in a.iter().zip(b).zip(out.iter_mut()) {
        *o = x + y;  // Often vectorizes
    }
}

// Help autovectorization:
// 1. Use iterators over indexing
// 2. Avoid early exits in loops
// 3. Use chunks_exact for aligned access
```

## Portable SIMD (Nightly)

```rust
#![feature(portable_simd)]
use std::simd::*;

fn sum_simd(data: &[f32]) -> f32 {
    let (prefix, middle, suffix) = data.as_simd::<8>();
    
    // Handle unaligned prefix
    let mut sum = prefix.iter().sum::<f32>();
    
    // SIMD loop - 8 floats at a time
    let mut simd_sum = f32x8::splat(0.0);
    for chunk in middle {
        simd_sum += *chunk;
    }
    sum += simd_sum.reduce_sum();
    
    // Handle unaligned suffix
    sum += suffix.iter().sum::<f32>();
    
    sum
}

fn dot_product(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    
    let (a_pre, a_mid, a_suf) = a.as_simd::<8>();
    let (b_pre, b_mid, b_suf) = b.as_simd::<8>();
    
    let scalar: f32 = a_pre.iter().zip(b_pre).map(|(x, y)| x * y).sum();
    
    let mut simd_sum = f32x8::splat(0.0);
    for (av, bv) in a_mid.iter().zip(b_mid) {
        simd_sum += *av * *bv;
    }
    
    let suffix: f32 = a_suf.iter().zip(b_suf).map(|(x, y)| x * y).sum();
    
    scalar + simd_sum.reduce_sum() + suffix
}
```

## wide Crate (Stable)

```rust
use wide::*;

fn process_simd(data: &mut [f32]) {
    // Process 8 floats at a time
    for chunk in data.chunks_exact_mut(8) {
        let v = f32x8::from(chunk);
        let result = v * f32x8::splat(2.0) + f32x8::splat(1.0);
        chunk.copy_from_slice(&result.to_array());
    }
}

fn blend_images(a: &[u8], b: &[u8], alpha: f32, out: &mut [u8]) {
    let alpha_v = f32x8::splat(alpha);
    let one_minus = f32x8::splat(1.0 - alpha);
    
    for ((a_chunk, b_chunk), out_chunk) in 
        a.chunks_exact(8).zip(b.chunks_exact(8)).zip(out.chunks_exact_mut(8)) 
    {
        let av = f32x8::from([
            a_chunk[0] as f32, a_chunk[1] as f32, /* ... */
        ]);
        let bv = f32x8::from([
            b_chunk[0] as f32, b_chunk[1] as f32, /* ... */
        ]);
        
        let result = av * one_minus + bv * alpha_v;
        // Convert back to u8...
    }
}
```

## Platform-Specific (When Needed)

```rust
#[cfg(target_arch = "x86_64")]
use std::arch::x86_64::*;

#[cfg(target_arch = "x86_64")]
#[target_feature(enable = "avx2")]
unsafe fn sum_avx2(data: &[f32]) -> f32 {
    let mut acc = _mm256_setzero_ps();
    let mut chunks = data.chunks_exact(8);
    for chunk in &mut chunks {
        let v = _mm256_loadu_ps(chunk.as_ptr());
        acc = _mm256_add_ps(acc, v);
    }

    // store the 8 lanes, then finish the reduction (and the remainder) in scalar
    let mut lanes = [0.0f32; 8];
    _mm256_storeu_ps(lanes.as_mut_ptr(), acc);
    lanes.iter().sum::<f32>() + chunks.remainder().iter().sum::<f32>()
}
```

## Choosing an Approach

| Approach | Stability | Portability | Control |
|----------|-----------|-------------|---------|
| Autovectorization | Stable | Excellent | Low |
| `wide` crate | Stable | Good | Medium |
| Portable SIMD | Nightly | Excellent | High |
| Intrinsics | Stable | None | Maximum |

## See Also

- [opt-target-cpu](./opt-target-cpu.md) - Enable SIMD features
- [opt-bounds-check](./opt-bounds-check.md) - Unchecked access for SIMD
- [perf-profile-first](./perf-profile-first.md) - Identify vectorization opportunities
