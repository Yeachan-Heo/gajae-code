# trait-blanket-impl

> Use a blanket impl `impl<T: Bound> Trait for T` to give behaviour to every type that satisfies a bound

## Why It Matters

A blanket impl extends an entire class of types at once without touching each one individually. The standard library uses this pervasively: `ToString` is blanket-implemented for every `T: Display`, so any type that implements `Display` automatically gets `.to_string()`. This avoids repetitive boilerplate and keeps extension traits composable. The trade-off is coherence: Rust's orphan rules allow at most one applicable impl per type, so a blanket impl can conflict with a more specific one if not designed carefully. Adding a blanket impl is also a **semver-breaking change** if it could overlap with impls that downstream crates provide.

## Bad

```rust
use std::fmt;

trait Describe {
    fn describe(&self) -> String;
}

// Manual impl for each type — tedious and doesn't scale.
impl Describe for i32 {
    fn describe(&self) -> String { format!("i32: {self}") }
}
impl Describe for f64 {
    fn describe(&self) -> String { format!("f64: {self}") }
}
impl Describe for bool {
    fn describe(&self) -> String { format!("bool: {self}") }
}
// ... repeated for every type that happens to implement Display
```

## Good

```rust
use std::fmt;

// Extension trait that any `Display` type receives automatically.
trait Describe {
    fn describe(&self) -> String;
}

// One blanket impl covers every T: Display — mirrors how std blanket-impls ToString.
impl<T: fmt::Display> Describe for T {
    fn describe(&self) -> String {
        format!("{} ({})", self, std::any::type_name::<T>())
    }
}

// ----- Downstream usage: zero extra code required -----

fn print_described(value: &impl Describe) {
    println!("{}", value.describe());
}

fn demo() {
    print_described(&42_i32);
    print_described(&3.14_f64);
    print_described(&true);
    print_described(&"hello");
}

// ----- You CANNOT also override it for one type -----
// Writing `impl Describe for MyType` while the blanket impl exists is a
// coherence conflict (E0119): stable Rust has no specialization, so a blanket
// impl and a specific impl can never overlap. If you need a per-type override,
// don't use a blanket impl — or wrap the type in a newtype (see See Also).
```

## Key Points

- The standard library blanket-impls `ToString` for all `T: Display`, `From<T> for T` (reflexive), and `impl<T: Error> From<T> for Box<dyn Error>`.
- Blanket impls live in the crate that owns the **trait** (not the type), satisfying the orphan rule.
- A blanket impl prevents any specific impl for a type it already covers — that overlap is a coherence error (E0119), because specialization is not stable. Use a newtype when you need a per-type override.
- Treat adding a public blanket impl as a **minor semver bump at minimum** (or major if it could break downstream).
- Pair blanket impls with sealed traits (`api-sealed-trait`) when you want the blanket behaviour but need to prevent external implementations.

## See Also

- [api-extension-trait](api-extension-trait.md) - add methods to foreign types via extension traits
- [api-sealed-trait](api-sealed-trait.md) - prevent external implementations of a trait
- [trait-coherence-newtype](trait-coherence-newtype.md) - use a newtype to implement a foreign trait on a foreign type
