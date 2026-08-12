# num-saturating-clamp

> Bound values with `clamp` and saturating arithmetic

## Why It Matters

Constraining a numeric value to a range is a common operation, but hand-rolled `if`/`min`/`max` chains are verbose and easy to get wrong (especially when combining signed and unsigned types). `Ord::clamp(min, max)` expresses the intent in a single call and is available on all types that implement `Ord` (all integer primitives, and `f32`/`f64` via their own `clamp` since Rust 1.50). When you additionally want arithmetic that stops at the type's limits rather than panicking or wrapping, combine `clamp` with `saturating_*` methods.

## Bad

```rust
fn apply_damage(health: i32, damage: i32) -> i32 {
    let result = health - damage;
    if result < 0 { 0 } else { result }  // verbose, easy to mis-order
}

fn clamp_volume(vol: u8, min: u8, max: u8) -> u8 {
    if vol < min {
        min
    } else if vol > max {
        max
    } else {
        vol
    }
}
```

## Good

```rust
fn apply_damage(health: i32, damage: i32) -> i32 {
    // saturating_sub stops at i32::MIN — then clamp ensures non-negative
    health.saturating_sub(damage).clamp(0, i32::MAX)
}

fn clamp_volume(vol: u8, min: u8, max: u8) -> u8 {
    vol.clamp(min, max)
}

// integer clamp: any Ord type
fn clamp_score(score: i64) -> i64 {
    score.clamp(0, 100)
}

// float clamp: available on f32/f64 since Rust 1.50
fn normalize_alpha(a: f32) -> f32 {
    a.clamp(0.0, 1.0)  // NaN propagates: NaN.clamp(0.0, 1.0) == NaN
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn damage_does_not_go_below_zero() {
        assert_eq!(apply_damage(10, 5), 5);
        assert_eq!(apply_damage(3, 100), 0);
    }

    #[test]
    fn volume_is_bounded() {
        assert_eq!(clamp_volume(50, 10, 90), 50);
        assert_eq!(clamp_volume(5, 10, 90), 10);
        assert_eq!(clamp_volume(200, 10, 90), 90);
    }

    #[test]
    fn score_is_clamped() {
        assert_eq!(clamp_score(-10), 0);
        assert_eq!(clamp_score(150), 100);
        assert_eq!(clamp_score(75), 75);
    }

    #[test]
    fn float_nan_propagates_through_clamp() {
        assert!(f32::NAN.clamp(0.0, 1.0).is_nan());
    }
}
```

## Key Points

- **`clamp` panics if `min > max`** — this is a programming error and is caught in debug builds. If `min`/`max` come from user input, validate their order first.
- **`f32`/`f64` `clamp`** propagates `NaN`: if `self` is `NaN`, the result is `NaN`. If `min` or `max` is `NaN`, the result is unspecified. Filter `NaN` before calling `clamp` on untrusted floats.
- **Saturating vs. clamping**: `saturating_*` applies to a single arithmetic operation and stops at the type's absolute limits (`i32::MIN`/`i32::MAX`). `clamp` applies to the final value and accepts arbitrary bounds. They compose well, as shown in `apply_damage`.
- The standard library docs for `clamp` are at `std::cmp::Ord::clamp` and `f32::clamp`.

## See Also

- [num-overflow-explicit](num-overflow-explicit.md) - handle overflow with `checked_`/`saturating_`/`wrapping_`/`overflowing_`
- [num-cast-try-from](num-cast-try-from.md) - avoid `as` for narrowing casts; prefer `TryFrom`
