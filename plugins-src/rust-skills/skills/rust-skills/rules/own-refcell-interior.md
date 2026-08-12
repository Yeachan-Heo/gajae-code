# own-refcell-interior

> Use `RefCell<T>` for interior mutability in single-threaded code

## Why It Matters

Rust's borrow checker enforces rules at compile time, but sometimes you need to mutate data through a shared reference. `RefCell<T>` moves borrow checking to runtime, allowing mutation through `&self`. This is essential for patterns like caches, lazy initialization, and observer patterns where compile-time borrowing is too restrictive.

## Bad

```rust
struct Cache {
    // Requires &mut self to update, breaking shared reference patterns
    data: HashMap<String, String>,
}

impl Cache {
    fn get_or_compute(&mut self, key: &str) -> &str {
        // Caller needs &mut Cache, can't share cache reference
        if !self.data.contains_key(key) {
            self.data.insert(key.to_string(), expensive_compute(key));
        }
        &self.data[key]
    }
}
```

This forces exclusive access even for logically shared operations.

## Good

```rust
use std::cell::RefCell;
use std::collections::HashMap;

struct Cache {
    data: RefCell<HashMap<String, String>>,
}

impl Cache {
    fn get_or_compute(&self, key: &str) -> String {
        // Can mutate through &self
        let mut data = self.data.borrow_mut();
        if !data.contains_key(key) {
            data.insert(key.to_string(), expensive_compute(key));
        }
        data[key].clone()
    }
}

// Multiple references can coexist
let cache = Cache::new();
let ref1 = &cache;
let ref2 = &cache;
ref1.get_or_compute("key1");
ref2.get_or_compute("key2");
```

## Common Pattern: Rc<RefCell<T>>

```rust
use std::rc::Rc;
use std::cell::RefCell;

// Shared mutable state in single-threaded code
type SharedState = Rc<RefCell<AppState>>;

fn create_handlers(state: SharedState) -> Vec<Box<dyn Fn()>> {
    vec![
        Box::new({
            let state = state.clone();
            move || state.borrow_mut().increment()
        }),
        Box::new({
            let state = state.clone();
            move || state.borrow_mut().decrement()
        }),
    ]
}
```

## Runtime Panics

`RefCell` panics if you violate borrowing rules at runtime:

```rust
let cell = RefCell::new(5);
let borrow1 = cell.borrow();
let borrow2 = cell.borrow_mut(); // PANIC: already borrowed
```

Use `try_borrow()` and `try_borrow_mut()` for fallible borrowing.

## Cell for Copy Types

For simple `Copy` values, `Cell<T>` is lighter than `RefCell<T>` — no runtime borrow flags, no panics. You `get()`/`set()`/`replace()` the value instead of borrowing it:

```rust
use std::cell::Cell;

struct Counter {
    count: Cell<u32>,
}

impl Counter {
    fn bump(&self) {
        self.count.set(self.count.get() + 1); // mutate through &self, never panics
    }
}
```

## See Also

- [own-rc-single-thread](./own-rc-single-thread.md) - Combining with Rc for shared ownership
- [own-mutex-interior](./own-mutex-interior.md) - Thread-safe alternative
- [conc-thread-local](./conc-thread-local.md) - `thread_local!` with `Cell`/`RefCell` for per-thread state
