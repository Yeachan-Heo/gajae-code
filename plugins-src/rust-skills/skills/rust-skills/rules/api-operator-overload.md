# api-operator-overload

> Overload operators only when the semantics are natural and unsurprising

## Why It Matters

Rust allows operator overloading through traits in `std::ops` (`Add`, `Sub`, `Mul`, `Index`, `Neg`, etc.). The Rust API Guidelines (C-OVERLOAD) permit this — but only when the operator meaning is immediately obvious to any reader. Natural fits: arithmetic on numeric newtypes, vector/matrix math, set union/intersection with `+`/`|`, duration arithmetic. Surprising overloads — `+` that mutates state, `*` that performs a network call, `Index` that panics unconditionally — mislead readers and violate the principle of least surprise. When in doubt, name a method instead. Also implement the operator for references to avoid forcing callers to clone.

## Bad

```rust
use std::ops::Add;

struct Logger(Vec<String>);

// Anti-pattern: + mutates internal state and has a side effect
impl Add<String> for Logger {
    type Output = Logger;

    fn add(mut self, msg: String) -> Logger {
        self.0.push(msg.clone());
        println!("logged: {msg}"); // side effect in an operator
        self
    }
}
```

## Good

```rust
use std::ops::{Add, Neg};

#[derive(Debug, Clone, Copy, PartialEq)]
struct Vector2 {
    x: f64,
    y: f64,
}

impl Vector2 {
    pub fn new(x: f64, y: f64) -> Self {
        Vector2 { x, y }
    }

    pub fn dot(self, other: Vector2) -> f64 {
        self.x * other.x + self.y * other.y
    }
}

// Add for owned values
impl Add for Vector2 {
    type Output = Vector2;

    fn add(self, rhs: Vector2) -> Vector2 {
        Vector2::new(self.x + rhs.x, self.y + rhs.y)
    }
}

// Also implement for references — avoids forcing callers to clone
impl Add for &Vector2 {
    type Output = Vector2;

    fn add(self, rhs: &Vector2) -> Vector2 {
        Vector2::new(self.x + rhs.x, self.y + rhs.y)
    }
}

impl Neg for Vector2 {
    type Output = Vector2;

    fn neg(self) -> Vector2 {
        Vector2::new(-self.x, -self.y)
    }
}

fn main() {
    let a = Vector2::new(1.0, 2.0);
    let b = Vector2::new(3.0, 4.0);

    let c = a + b;               // owned
    let d = &a + &b;             // borrowed — no clone needed
    let e = -a;

    assert_eq!(c, Vector2::new(4.0, 6.0));
    assert_eq!(d, Vector2::new(4.0, 6.0));
    assert_eq!(e, Vector2::new(-1.0, -2.0));
}
```

## Decision Guide

| Situation | Verdict |
|-----------|---------|
| Arithmetic on a numeric newtype or geometric type | Implement |
| Set operations (`|` for union, `&` for intersection) | Implement |
| String concatenation on a custom string type | Implement |
| `Index`/`IndexMut` on a container that holds items | Implement |
| `+` or `*` with visible side effects | Never |
| Operator meaning depends on context not captured by types | Use a named method |

## Notes

- Always implement the corresponding assignment operator (`AddAssign`, `SubAssign`, etc.) when you implement the binary op.
- Prefer implementing for both owned and `&` forms to give callers flexibility without extra copies.
- Consider `std::ops::Mul<f64> for Vector2` (scalar multiply) alongside `Mul<Vector2>` — real-world numeric types often need several rhs types.

## See Also

- [type-newtype-ids](type-newtype-ids.md) - wrapping values in newtypes that may need operators
- [api-common-traits](api-common-traits.md) - implement `Debug`, `Clone`, `PartialEq` eagerly
