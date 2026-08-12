# num-nonzero

> Use `NonZero*` types to forbid zero and unlock the niche optimization

## Why It Matters

`NonZeroU32`, `NonZeroI64`, and their siblings (available for all integer primitives in `std::num`) make zero unrepresentable at the type level — you cannot construct one without going through `NonZeroU32::new(n)`, which returns `Option<NonZeroU32>`. This pushes the zero-check to the construction site and eliminates defensive zero-checks throughout the rest of the code. As a bonus, the compiler uses the zero bit-pattern as a *niche*, so `Option<NonZeroU32>` is exactly the same size as `u32` — no overhead for the `Option` tag.

## Bad

```rust
// caller must remember never to pass 0, but nothing enforces it
fn divide(numerator: u32, denominator: u32) -> u32 {
    assert!(denominator != 0, "denominator must not be zero");
    numerator / denominator
}

// ID of 0 is "invalid" by convention — not enforced
struct Widget {
    id: u32,  // 0 means "not yet assigned" — stringly-typed convention
}
```

## Good

```rust
use std::num::NonZeroU32;
use std::mem::size_of;

// zero is rejected at construction; division is always safe
fn divide(numerator: u32, denominator: NonZeroU32) -> u32 {
    numerator / denominator.get()
}

// ID is guaranteed non-zero; Option<WidgetId> is free
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct WidgetId(NonZeroU32);

impl WidgetId {
    /// Returns `None` if `id` is zero.
    pub fn new(id: u32) -> Option<Self> {
        NonZeroU32::new(id).map(WidgetId)
    }

    pub fn get(self) -> u32 {
        self.0.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::num::NonZeroU32;

    #[test]
    fn nonzero_new_returns_none_for_zero() {
        assert!(NonZeroU32::new(0).is_none());
        assert!(NonZeroU32::new(1).is_some());
    }

    #[test]
    fn option_nonzero_is_same_size_as_u32() {
        // niche optimization: no space overhead for Option
        assert_eq!(size_of::<Option<NonZeroU32>>(), size_of::<u32>());
        assert_eq!(size_of::<Option<NonZeroU32>>(), 4);
    }

    #[test]
    fn widget_id_rejects_zero() {
        assert!(WidgetId::new(0).is_none());
        let id = WidgetId::new(42).unwrap();
        assert_eq!(id.get(), 42);
    }

    #[test]
    fn divide_uses_nonzero_denominator() {
        let denom = NonZeroU32::new(3).unwrap();
        assert_eq!(divide(12, denom), 4);
    }
}
```

## Key Points

- All `NonZero*` types live in `std::num`: `NonZeroU8`, `NonZeroU16`, `NonZeroU32`, `NonZeroU64`, `NonZeroU128`, `NonZeroUsize`, and their signed counterparts.
- **Construction**: `NonZeroU32::new(n) -> Option<NonZeroU32>`. Use `NonZeroU32::new(n).expect("n must be non-zero")` only at well-verified program boundaries, not in production fallible paths.
- **Access**: `.get()` returns the inner primitive value.
- **Arithmetic**: `NonZeroU32` does not implement `Add`/`Sub` directly (the result could be zero). Extract with `.get()`, do arithmetic, and reconstruct with `NonZeroU32::new(result)?`.
- **Niche optimization** applies to `Option` and `Result`: the compiler stores the `None`/`Err` discriminant in the zero bit-pattern, so no extra word is needed. This also applies to custom newtypes that wrap `NonZero*`.

## See Also

- [type-newtype-ids](type-newtype-ids.md) - wrap IDs in newtypes for type-safe distinctions
- [mem-smaller-integers](mem-smaller-integers.md) - use the smallest integer type that fits
