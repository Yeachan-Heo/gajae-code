# closure-impl-fn-return

> Return closures as `impl Fn`/`FnMut`/`FnOnce`, not `Box<dyn Fn>`

## Why It Matters

`impl Fn` in return position names the closure's concrete (but unnameable) type and enables static dispatch with no heap allocation. `Box<dyn Fn>` adds an allocation and a virtual call every time the closure is invoked. The opaque `impl Trait` syntax was designed precisely for this use case. Reach for `Box<dyn Fn>` only when the function must return *different* closure types depending on runtime conditions, or when the closure must be stored in a struct field or collection.

## Bad

```rust
// Allocates on the heap for no benefit — single concrete closure type.
fn adder_bad(n: i32) -> Box<dyn Fn(i32) -> i32> {
    Box::new(move |x| x + n)
}

fn multiplier_bad(n: i32) -> Box<dyn Fn(i32) -> i32> {
    Box::new(move |x| x * n)
}
```

## Good

```rust
// Zero allocation, statically dispatched.
fn adder(n: i32) -> impl Fn(i32) -> i32 {
    move |x| x + n
}

fn multiplier(n: i32) -> impl Fn(i32) -> i32 {
    move |x| x * n
}

fn apply(f: impl Fn(i32) -> i32, value: i32) -> i32 {
    f(value)
}

fn demo() {
    let add5 = adder(5);
    let mul3 = multiplier(3);

    assert_eq!(apply(add5, 10), 15);
    assert_eq!(apply(mul3, 10), 30);
}
```

## Key Points

**When `Box<dyn Fn>` is required:**

Different `if`/`match` arms return distinct closure types, so `impl Fn` cannot unify them:

```rust
fn make_transform(double: bool) -> Box<dyn Fn(i32) -> i32> {
    if double {
        Box::new(|x| x * 2)   // one concrete type
    } else {
        Box::new(|x| x + 100) // different concrete type
    }
    // `impl Fn` would fail: "expected closure, found a different closure"
}

// Storing heterogeneous closures also requires boxing:
struct Pipeline {
    steps: Vec<Box<dyn Fn(i32) -> i32>>,
}

impl Pipeline {
    fn new() -> Self {
        Self { steps: Vec::new() }
    }

    fn add_step(&mut self, f: impl Fn(i32) -> i32 + 'static) {
        self.steps.push(Box::new(f));
    }

    fn run(&self, mut value: i32) -> i32 {
        for step in &self.steps {
            value = step(value);
        }
        value
    }
}

fn demo_pipeline() {
    let mut p = Pipeline::new();
    p.add_step(|x| x + 1);
    p.add_step(|x| x * 3);
    assert_eq!(p.run(4), 15);
}
```

**Returning `FnMut`:** The binding at the call site must be `mut`.

```rust
fn counter(start: i32) -> impl FnMut() -> i32 {
    let mut n = start;
    move || {
        let current = n;
        n += 1;
        current
    }
}

fn demo_counter() {
    let mut next = counter(0);
    assert_eq!(next(), 0);
    assert_eq!(next(), 1);
}
```

## See Also

- [anti-type-erasure](anti-type-erasure.md) - avoid `Box<dyn Trait>` when `impl Trait` works
- [closure-static-vs-dyn](closure-static-vs-dyn.md) - static vs dynamic dispatch trade-offs for callbacks
