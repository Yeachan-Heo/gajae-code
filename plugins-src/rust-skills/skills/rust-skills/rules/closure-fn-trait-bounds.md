# closure-fn-trait-bounds

> Require the least restrictive `Fn` trait a callback needs (`FnOnce` ⊇ `FnMut` ⊇ `Fn`)

## Why It Matters

`FnOnce` is implemented by every closure — it may consume its captures and can only be called once. `FnMut` is implemented by closures that mutate captures, and implies `FnOnce`. `Fn` is the strictest: it only reads captures and can be called any number of times concurrently. Bounding a parameter with the weakest trait the body actually requires accepts the widest set of callers. Requiring `Fn` when you only call the closure once needlessly rejects move-consuming closures.

## Bad

```rust
// F: Fn is too strict — the closure is only called once,
// so move-consuming closures are unnecessarily rejected.
fn run_once_bad<F: Fn() -> String>(f: F) -> String {
    f()
}

fn demo_bad() {
    let s = String::from("hello");
    // This closure consumes `s`, so it only implements FnOnce, not Fn.
    // run_once_bad(move || s) // compile error: `s` moved in closure
    let _ = run_once_bad(|| String::from("ok")); // forced to use non-consuming closure
}
```

## Good

```rust
// Use FnOnce when you call the closure exactly once.
fn run_once<F: FnOnce() -> String>(f: F) -> String {
    f()
}

// Use FnMut when you call the closure multiple times and it may mutate state.
fn retry<F: FnMut() -> bool>(mut f: F, attempts: usize) -> bool {
    for _ in 0..attempts {
        if f() {
            return true;
        }
    }
    false
}

// Use Fn when you call the closure multiple times and need it shareable/re-entrant.
fn for_each<T, F: Fn(&T)>(items: &[T], f: F) {
    for item in items {
        f(item);
    }
}

fn demo() {
    // FnOnce: move-consuming closure is accepted
    let s = String::from("hello");
    let result = run_once(move || s.to_uppercase());
    assert_eq!(result, "HELLO");

    // FnMut: closure mutates a counter
    let mut count = 0usize;
    let found = retry(
        || {
            count += 1;
            count == 3
        },
        5,
    );
    assert!(found);

    // Fn: read-only closure, called once per element
    let nums = vec![1, 2, 3];
    for_each(&nums, |n| println!("{n}"));
}
```

## Key Points

| Trait | Captures | Calls | Accepts |
|-------|----------|-------|---------|
| `FnOnce` | may consume | exactly once | all closures |
| `FnMut` | may mutate | multiple | non-consuming |
| `Fn` | read-only | multiple / shared | pure closures |

- `FnMut` requires `mut f` at the call site (the parameter or binding must be `mut`).
- `Fn: FnMut: FnOnce` — a `Fn` closure satisfies an `FnOnce` bound, not the other way around.
- Standard library examples: `Iterator::map` uses `FnMut`; `thread::spawn` uses `FnOnce + Send + 'static`.

## See Also

- [closure-static-vs-dyn](closure-static-vs-dyn.md) - generic vs dynamic dispatch for callbacks
- [closure-move-capture](closure-move-capture.md) - when and how to use `move` closures
