# macro-rules-hygiene

> Rely on `macro_rules!` hygiene and use `$crate` for paths to your crate's items

## Why It Matters

`macro_rules!` is hygienic for local bindings: identifiers introduced inside the macro (with `let`, loop labels, etc.) live in their own namespace and cannot shadow or clash with the caller's identifiers. This protects callers from surprising capture bugs.

Item paths, however, are not automatically resolved. If your macro calls `crate::helper()`, it silently breaks when the macro is used from a different crate. Use `$crate::helper()` instead — `$crate` expands to the defining crate regardless of call site, so the macro works correctly even when re-exported.

## Bad

```rust
// lib.rs
pub fn log_value(v: &str) {
    println!("[log] {v}");
}

#[macro_export]
macro_rules! log {
    ($val:expr) => {
        // WRONG: `crate::` resolves relative to the *caller's* crate,
        // not to the crate that defined this macro.
        crate::log_value(&format!("{:?}", $val));
    };
}
```

```rust
// consumer/src/main.rs
use mylib::log;

fn main() {
    log!(42); // compile error: `crate::log_value` not found in consumer
}
```

## Good

```rust
// lib.rs
pub fn log_value(v: &str) {
    println!("[log] {v}");
}

#[macro_export]
macro_rules! log {
    ($val:expr) => {
        // `$crate` always expands to the crate that defined this macro.
        $crate::log_value(&format!("{:?}", $val));
    };
}
```

```rust
// consumer/src/main.rs
use mylib::log;

fn main() {
    log!(42); // correctly calls mylib::log_value
}
```

## Hygiene for Local Bindings

Hygiene means that `let` bindings introduced inside a macro are invisible to the caller:

```rust
macro_rules! swap {
    ($a:expr, $b:expr) => {{
        // `tmp` here does NOT interfere with any `tmp` in the caller's scope.
        let tmp = $a;
        $a = $b;
        $b = tmp;
    }};
}

fn main() {
    let tmp = "outer";        // unrelated to the macro's `tmp`
    let (mut x, mut y) = (1, 2);
    swap!(x, y);
    assert_eq!((x, y), (2, 1));
    assert_eq!(tmp, "outer"); // still intact
}
```

## Key Points

- Always use `$crate::` for any path to items in the defining crate.
- `$crate` works even when the macro is re-exported through another crate.
- Hygiene does NOT protect against identifier tokens you pass as `$name:ident` — those come from the caller's scope intentionally.
- For items meant to be called from generated code, combine `$crate::` with a `#[doc(hidden)] pub mod __private` to avoid polluting the public API (see `macro-private-helpers`).

## See Also

- [macro-export-crate-path](macro-export-crate-path.md) - exporting macros with clean import paths
- [macro-private-helpers](macro-private-helpers.md) - hiding helper items used by macros
- [macro-prefer-functions](macro-prefer-functions.md) - when to avoid macros entirely
