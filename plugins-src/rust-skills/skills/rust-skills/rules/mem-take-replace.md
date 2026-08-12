# mem-take-replace

> Use `mem::take` / `mem::replace` to move a value out of a `&mut` without cloning

## Why It Matters

Rust's ownership rules prevent you from moving a field out of a `&mut self` reference — the compiler must guarantee the field is not left in an invalid state. The standard workaround many developers reach for is `.clone()`, but that allocates unnecessarily. `std::mem::take` swaps the field with `T::default()` and returns the original value; `std::mem::replace` swaps in an explicit value of your choosing. Both are zero-copy and work wherever you have `&mut T`.

## Bad

```rust
struct Processor {
    items: Vec<String>,
}

impl Processor {
    // clones the entire Vec just to drain it — unnecessary allocation
    fn flush(&mut self) -> Vec<String> {
        let v = self.items.clone();
        self.items.clear();
        v
    }
}
```

## Good

```rust
use std::mem;

struct Processor {
    items: Vec<String>,
}

impl Processor {
    // moves the Vec out in one step, leaving an empty Vec behind
    fn flush(&mut self) -> Vec<String> {
        mem::take(&mut self.items)
    }
}
```

`mem::take` is equivalent to `mem::replace(&mut self.items, Vec::new())` but shorter when the replacement value is `Default::default()`.

## State-Machine Transition with `mem::replace`

A common pattern in state machines and `Future::poll` implementations is replacing a field with an explicit next state rather than the default:

```rust
use std::mem;

#[derive(Debug)]
enum State {
    Idle,
    Loading { url: String },
    Done { body: String },
}

impl Default for State {
    fn default() -> Self {
        State::Idle
    }
}

struct Machine {
    state: State,
}

impl Machine {
    fn start_load(&mut self, url: String) {
        // replace Idle with Loading, getting Idle back (discarded here)
        let _prev = mem::replace(&mut self.state, State::Loading { url });
    }

    fn complete(&mut self, body: String) {
        // replace Loading with Done; capture old state if needed for logging
        match mem::replace(&mut self.state, State::Done { body }) {
            State::Loading { url } => {
                println!("finished loading {url}");
            }
            other => {
                // unexpected transition — put it back or handle the error
                self.state = other;
            }
        }
    }
}
```

## Consuming a Field in `Drop`

`mem::take` is also the idiomatic way to move out of a field inside `Drop`, where you only have `&mut self`:

```rust
use std::mem;

struct FileWriter {
    buffer: Vec<u8>,
    // imagine a real file handle here
}

impl Drop for FileWriter {
    fn drop(&mut self) {
        let data = mem::take(&mut self.buffer);
        // flush `data` to disk without an extra allocation
        let _ = data; // pretend this writes somewhere
    }
}
```

## Key Points

- `mem::take` requires `T: Default`. If `T` has no meaningful default, use `mem::replace` with an explicit sentinel value (e.g., an `Option<T>` field — `mem::take` an `Option<T>` yields `None`, which is often exactly right).
- Both functions are `#[inline]` and compile away to a few register moves with no heap involvement.
- `Option<T>` is a natural pairing: keep expensive values in `Option<T>` and call `self.field.take()` (the `Option::take` method, same idea) to move ownership out cleanly.

## See Also

- [own-move-large](own-move-large.md) - move large data instead of cloning
- [mem-clone-from](mem-clone-from.md) - use `clone_from()` to reuse allocations
- [own-borrow-over-clone](own-borrow-over-clone.md) - prefer `&T` borrowing over `.clone()`
