# num-float-compare

> Don't compare floats with `==`; use a tolerance, and `total_cmp` for ordering

## Why It Matters

Floating-point arithmetic is not exact: `0.1 + 0.2 == 0.3` evaluates to `false` in Rust (and every IEEE 754 language) because neither value is representable exactly in binary. Additionally, `NaN != NaN` by the IEEE 754 standard, so equality comparisons involving `NaN` always return `false`. For sorting, `f64::partial_cmp` returns `None` on `NaN`, which makes `sort_by` panic with an inconsistent-order error. Use an epsilon tolerance for approximate equality and `f64::total_cmp` (stable since Rust 1.62) for total ordering.

## Bad

```rust
fn is_unit_length(x: f64, y: f64) -> bool {
    (x * x + y * y).sqrt() == 1.0  // almost always false due to rounding
}

fn sort_scores(scores: &mut Vec<f64>) {
    scores.sort_by(|a, b| a.partial_cmp(b).unwrap());
    // panics (unwrap on None) if any score is NaN
}
```

## Good

```rust
// approximate equality with an absolute epsilon
fn approx_eq(a: f64, b: f64, epsilon: f64) -> bool {
    (a - b).abs() < epsilon
}

fn is_unit_length(x: f64, y: f64) -> bool {
    approx_eq((x * x + y * y).sqrt(), 1.0, 1e-9)
}

// total ordering: NaN sorts after everything else (consistent, never panics)
fn sort_scores(scores: &mut Vec<f64>) {
    scores.sort_by(|a, b| a.total_cmp(b));
}

// direct NaN check when needed
fn safe_reciprocal(x: f64) -> Option<f64> {
    if x == 0.0 || x.is_nan() {
        None
    } else {
        Some(1.0 / x)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_addition_is_not_exact() {
        assert_ne!(0.1_f64 + 0.2, 0.3);  // IEEE 754 rounding
        assert!(approx_eq(0.1 + 0.2, 0.3, 1e-10));
    }

    #[test]
    fn nan_is_not_equal_to_itself() {
        let nan = f64::NAN;
        assert_ne!(nan, nan);  // NaN != NaN by IEEE 754
    }

    #[test]
    fn total_cmp_handles_nan() {
        let mut v = vec![3.0_f64, f64::NAN, 1.0, f64::NAN, 2.0];
        sort_scores(&mut v);
        // NaN values sort to the end; finite values are in order
        assert_eq!(&v[..3], &[1.0, 2.0, 3.0]);
        assert!(v[3].is_nan());
        assert!(v[4].is_nan());
    }

    #[test]
    fn unit_length_uses_tolerance() {
        assert!(is_unit_length(1.0, 0.0));
        assert!(is_unit_length(0.6, 0.8));  // 3-4-5 right triangle scaled
    }
}
```

## Key Points

- **Epsilon choice**: an absolute epsilon (`1e-9`) is simple but wrong for very large or very small values. For general-purpose code, a relative epsilon `(a - b).abs() / a.abs().max(b.abs()) < epsilon` is more robust — but requires handling the zero case.
- **`f64::total_cmp`** defines a strict total order: `-NaN < -∞ < … < -0.0 < +0.0 < … < +∞ < NaN`. It never panics and is available on `f32` and `f64`.
- **`is_nan` / `is_infinite` / `is_finite`**: use these predicates before arithmetic on untrusted floats.
- **Equality on `f32`/`f64` with `==`** is intentionally kept in the language for cases where you need bit-exact comparison (e.g., checking whether a value changed since last write). Document such uses explicitly.

## See Also

- [num-overflow-explicit](num-overflow-explicit.md) - handle integer overflow explicitly
