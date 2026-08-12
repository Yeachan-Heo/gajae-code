# trait-object-safety

> Keep a trait dyn-compatible (object-safe) when you need `dyn Trait`

## Why It Matters

Only dyn-compatible traits can be used as `dyn Trait`. The Rust Reference defines dyn compatibility: every method must be dispatchable through a vtable, which means no generic type parameters on methods, no bare `Self` return or value position, and no associated constants. Violating these rules produces a hard compiler error at the `dyn` use site — often far from the trait definition. If you need both generic methods and `dyn Trait`, you can gate the non-dispatchable methods with `where Self: Sized`, which excludes them from the vtable while keeping the rest of the trait object-safe.

## Bad

```rust
trait Transformer {
    // Generic method — not dispatchable, makes the whole trait non-object-safe.
    fn transform<T: std::fmt::Debug>(&self, value: T) -> String;

    fn name(&self) -> &str;
}

struct Shout;
impl Transformer for Shout {
    fn transform<T: std::fmt::Debug>(&self, value: T) -> String {
        format!("{value:?}").to_uppercase()
    }
    fn name(&self) -> &str { "shout" }
}

// This fails to compile:
// error[E0038]: the trait `Transformer` cannot be made into an object
// fn apply(t: &dyn Transformer, x: i32) { ... }
```

## Good

```rust
trait Transformer {
    // Core dispatchable method — always in the vtable.
    fn transform_str(&self, value: &str) -> String;

    fn name(&self) -> &str;

    // Generic convenience method gated with `where Self: Sized`.
    // Callers can use it via a concrete type; it is excluded from `dyn Transformer`.
    fn transform_debug<T: std::fmt::Debug>(&self, value: T) -> String
    where
        Self: Sized,
    {
        self.transform_str(&format!("{value:?}"))
    }
}

// ----- Implementations -----

struct Shout;
impl Transformer for Shout {
    fn transform_str(&self, value: &str) -> String { value.to_uppercase() }
    fn name(&self) -> &str { "shout" }
}

struct Whisper;
impl Transformer for Whisper {
    fn transform_str(&self, value: &str) -> String { value.to_lowercase() }
    fn name(&self) -> &str { "whisper" }
}

// ----- Object-safe usage -----

fn apply_all(transformers: &[Box<dyn Transformer>], input: &str) {
    for t in transformers {
        println!("[{}] {}", t.name(), t.transform_str(input));
    }
}

// ----- Generic (static) usage — can call the `where Self: Sized` method -----

fn apply_generic<T: Transformer>(t: &T, value: i32) -> String {
    t.transform_debug(value)  // available because T: Sized
}

fn demo() {
    let ts: Vec<Box<dyn Transformer>> = vec![
        Box::new(Shout),
        Box::new(Whisper),
    ];
    apply_all(&ts, "Hello World");

    // Static dispatch path can use the generic helper.
    let result = apply_generic(&Shout, 42);
    println!("{result}");
}
```

## Dyn-Compatibility Rules (Quick Reference)

| Feature | Allowed in `dyn Trait`? |
|---|---|
| `&self` / `&mut self` methods | Yes |
| Methods returning `Self` by value | No — use `Box<Self>` or gate with `where Self: Sized` |
| Generic method parameters (`fn f<T>`) | No — gate with `where Self: Sized` |
| Associated constants | No |
| Associated types | Yes (type is erased but fixed per impl) |
| `where Self: Sized` methods | Excluded from vtable, safe to have |

See the Rust Reference — "Object Safety" — at doc.rust-lang.org/reference/items/traits.html#object-safety for the full rules.

## See Also

- [trait-dyn-vs-generic](trait-dyn-vs-generic.md) - choose between static and dynamic dispatch deliberately
- [anti-type-erasure](anti-type-erasure.md) - don't use `Box<dyn Trait>` when `impl Trait` works
- [api-sealed-trait](api-sealed-trait.md) - prevent external implementations of a trait
