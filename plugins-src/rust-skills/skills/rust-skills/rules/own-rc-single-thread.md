# own-rc-single-thread

> Use `Rc<T>` for shared ownership in single-threaded contexts

## Why It Matters

`Rc<T>` (Reference Counted) provides shared ownership without the atomic overhead of `Arc<T>`. In single-threaded code, `Rc` is faster because it uses non-atomic reference counting. Using `Arc` when you don't need thread-safety wastes CPU cycles on unnecessary synchronization.

## Bad

```rust
use std::sync::Arc;

// Single-threaded application using Arc unnecessarily
fn build_tree() -> Arc<Node> {
    let root = Arc::new(Node::new("root"));
    let child1 = Arc::new(Node::new("child1"));
    let child2 = Arc::new(Node::new("child2"));
    
    // All in same thread, but paying atomic overhead
    root.add_child(child1.clone());
    root.add_child(child2.clone());
    root
}
```

Atomic operations have measurable overhead even without contention.

## Good

```rust
use std::rc::Rc;

// Single-threaded: use Rc for zero atomic overhead
fn build_tree() -> Rc<Node> {
    let root = Rc::new(Node::new("root"));
    let child1 = Rc::new(Node::new("child1"));
    let child2 = Rc::new(Node::new("child2"));
    
    root.add_child(child1.clone());
    root.add_child(child2.clone());
    root
}

// Compiler enforces single-thread: Rc is !Send + !Sync
// Attempting to send across threads = compile error
```

## Decision Guide

| Scenario | Use |
|----------|-----|
| Single-threaded, shared ownership | `Rc<T>` |
| Multi-threaded, shared ownership | `Arc<T>` |
| Single owner, might need multiple later | Start with `Rc`, upgrade if needed |
| Library code, unknown threading model | `Arc<T>` (safer default) |

## Breaking Cycles with Weak

`Rc` never frees a value caught in a reference cycle — the strong count never reaches zero, so it leaks. Use `Weak<T>` for back-references (a child pointing at its parent): a `Weak` does not keep the value alive and is upgraded to an `Rc` only when needed.

```rust
use std::rc::{Rc, Weak};
use std::cell::RefCell;

struct Node {
    parent: RefCell<Weak<Node>>,        // back-reference: does not own the parent
    children: RefCell<Vec<Rc<Node>>>,
}

let parent = Rc::new(Node {
    parent: RefCell::new(Weak::new()),
    children: RefCell::new(vec![]),
});
let child = Rc::new(Node {
    parent: RefCell::new(Rc::downgrade(&parent)),
    children: RefCell::new(vec![]),
});
parent.children.borrow_mut().push(Rc::clone(&child));

// upgrade() yields Option<Rc<Node>> — None once the parent is dropped
let _maybe_parent: Option<Rc<Node>> = child.parent.borrow().upgrade();
```

## Key Points

- Prefer `Rc::clone(&x)` to `x.clone()`: it makes the cheap refcount bump explicit and visually distinct from a deep clone.
- `Rc<T>` gives shared *immutable* access; pair it with `RefCell<T>` (`Rc<RefCell<T>>`) for shared mutability in single-threaded code.
- `Rc::strong_count(&x)` / `Rc::weak_count(&x)` inspect the counts — handy in tests.
- `Rc` is `!Send` and `!Sync`, so the compiler rejects sending it across threads; switch to `Arc` (with `Mutex`/`RwLock`) at a thread boundary.

## See Also

- [own-arc-shared](./own-arc-shared.md) - When you need thread-safe sharing
- [own-refcell-interior](./own-refcell-interior.md) - Combining Rc with interior mutability
- [conc-thread-local](./conc-thread-local.md) - Per-thread state in single-threaded-style code
- [mem-drop-order](./mem-drop-order.md) - Drop order matters for cyclic/`Weak` structures
