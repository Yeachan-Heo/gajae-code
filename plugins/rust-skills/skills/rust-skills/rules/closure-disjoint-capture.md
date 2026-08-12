# closure-disjoint-capture

> Capture only what you use; lean on edition-2021 disjoint closure captures

## Why It Matters

Before the 2021 edition, a closure captured entire variables — using `config.threshold` pulled in the whole `config` struct, preventing other code from using any other field of `config` concurrently. Since Rust 2021, closures capture individual fields (`config.threshold` only), so sibling fields remain independently accessible. Take advantage of this: write closures that reference only the specific fields or values they need, and add `move` only when ownership is genuinely required. When you do need to `move` a single field, bind it to a local first so the rest of the struct stays usable.

## Bad

```rust
struct Config {
    threshold: i32,
    label: String,
}

fn demo_bad() {
    let config = Config { threshold: 10, label: String::from("demo") };

    // In pre-2021 editions the whole `config` is captured, blocking access
    // to `config.label` below. In 2021 this compiles, but the pattern of
    // capturing the whole struct via `move` is the real footgun:
    let threshold = config.threshold; // copy out the field first
    let check = move || threshold > 0; // now `config` is NOT fully moved

    // If instead you wrote: let check = move || config.threshold > 0;
    // `config` would be moved in, making `config.label` inaccessible afterwards.
    // Demonstrate the problematic pattern (commented out to allow compilation):
    // let check2 = move || config.threshold > 0;
    // println!("{}", config.label); // error: use of moved value

    println!("label still accessible: {}", config.label);
    assert!(check());
}
```

## Good

```rust
struct Config {
    threshold: i32,
    label: String,
}

fn demo_good() {
    let config = Config { threshold: 10, label: String::from("active") };

    // Edition 2021: the closure captures only `config.threshold` (a Copy field).
    // `config.label` is NOT captured, so it remains accessible.
    let check = || config.threshold > 0;

    // Both are usable simultaneously.
    println!("label: {}", config.label);  // fine — not captured by `check`
    assert!(check());
}

// When you need `move` for one field, bind it first.
fn make_checker(config: Config) -> (impl Fn() -> bool, String) {
    // Bind the field to a local, then move only that local into the closure.
    let threshold = config.threshold;
    let checker = move || threshold > 0; // moves `threshold` (i32, Copy), not `config`

    // `config.label` is still available here.
    (checker, config.label)
}

fn demo_bind_first() {
    let cfg = Config { threshold: 5, label: String::from("info") };
    let (check, label) = make_checker(cfg);
    println!("label returned: {label}");
    assert!(check());
}
```

## Key Points

- **Edition 2021 rule:** closures capture the *minimal* path used — `foo.bar` rather than `foo`. This reduces spurious borrow conflicts.
- **`move` captures the whole named place.** Writing `move || self.field` inside a method moves `*self`, not just `self.field`. Bind to a local to narrow the capture.
- **Copy types** (integers, booleans) are copied into the closure rather than moved, so the original remains valid even with `move`.
- **Borrow by reference first:** only escalate to `move` when the closure must outlive the scope (see [closure-move-capture](closure-move-capture.md)).

## See Also

- [own-borrow-over-clone](own-borrow-over-clone.md) - prefer borrowing over cloning
- [closure-move-capture](closure-move-capture.md) - when to use `move` and how to clone selectively
