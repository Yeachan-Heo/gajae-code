# trait-associated-type-vs-generic

> Use an associated type when each impl has exactly one output type; use a generic parameter when a type can implement the trait for many input types

## Why It Matters

The choice between `type Output;` and `<Rhs>` has two concrete consequences. First, an associated type is **part of the implementing type's identity**: callers never name it with turbofish because there is only one valid binding per impl. Second, a generic parameter allows **multiple simultaneous impls** on the same type — `impl Add<f64> for Vec2` and `impl Add<Vec2> for Vec2` can coexist, while `impl Iterator` can only define one `Item`. Using an associated type when multiple impls are needed makes those impls impossible; using a generic parameter when there is only one output forces every call site to write noisy turbofish or type annotations.

The Rust API Guidelines (rust-lang.github.io/api-guidelines/future-proofing.html) capture the rule: prefer associated types when there is a single natural output per implementor.

## Bad

```rust
// Using a generic parameter for a trait that has exactly one output per type.
// Callers must now write Parser<String, Output = Ast> or face ambiguity.
trait Parser<Output> {
    fn parse(&self, input: &str) -> Option<Output>;
}

struct JsonParser;

// Only one sensible Output ever exists for JsonParser, but the signature
// forces a type parameter that adds noise everywhere.
impl Parser<String> for JsonParser {
    fn parse(&self, input: &str) -> Option<String> {
        Some(input.to_owned())
    }
}

fn run<P: Parser<String>>(p: &P, s: &str) -> Option<String> {
    p.parse(s)
}
```

## Good

```rust
// ----- Associated type: one output per implementor -----
// Mirrors std::iter::Iterator { type Item; }

trait Parser {
    type Output;
    fn parse(&self, input: &str) -> Option<Self::Output>;
}

struct JsonParser;
struct NumberParser;

#[derive(Debug)]
struct JsonValue(String);

impl Parser for JsonParser {
    type Output = JsonValue;
    fn parse(&self, input: &str) -> Option<JsonValue> {
        Some(JsonValue(input.to_owned()))
    }
}

impl Parser for NumberParser {
    type Output = f64;
    fn parse(&self, input: &str) -> Option<f64> {
        input.trim().parse().ok()
    }
}

// No turbofish needed — `P::Output` is unambiguous.
fn run<P: Parser>(p: &P, s: &str) -> Option<P::Output> {
    p.parse(s)
}

// ----- Generic parameter: multiple impls on the same type -----
// Mirrors std::ops::Add<Rhs> and std::convert::From<T>.

#[derive(Debug, Clone, Copy)]
struct Vec2 { x: f64, y: f64 }

// One type implementing the same "add" concept for two different Rhs types.
impl std::ops::Add<Vec2> for Vec2 {
    type Output = Vec2;
    fn add(self, rhs: Vec2) -> Vec2 { Vec2 { x: self.x + rhs.x, y: self.y + rhs.y } }
}

impl std::ops::Add<f64> for Vec2 {
    type Output = Vec2;
    fn add(self, rhs: f64) -> Vec2 { Vec2 { x: self.x + rhs, y: self.y + rhs } }
}

fn demo() {
    let a = Vec2 { x: 1.0, y: 2.0 };
    let b = Vec2 { x: 3.0, y: 4.0 };
    let _ = a + b;       // Add<Vec2>
    let _ = a + 10.0;    // Add<f64>

    let p = NumberParser;
    if let Some(n) = run(&p, " 3.14 ") {
        println!("{n}");
    }
}
```

## Key Points

- `std::iter::Iterator`, `std::future::Future`, and `std::ops::Deref` all use associated types because there is exactly one `Item`/`Output`/`Target` per implementor.
- `std::ops::Add<Rhs>`, `std::convert::From<T>`, and `std::convert::Into<T>` use generic parameters because a single type can add to, or convert from, many others.
- When you need to constrain the associated type in a bound, write `P: Parser<Output = JsonValue>` — less noisy than a free generic parameter.

## See Also

- [type-generic-bounds](type-generic-bounds.md) - add trait bounds only where needed
- [trait-default-methods](trait-default-methods.md) - define traits with required + defaulted methods
- [api-impl-fromiterator](api-impl-fromiterator.md) - implementing `FromIterator` (associated-type pattern)
