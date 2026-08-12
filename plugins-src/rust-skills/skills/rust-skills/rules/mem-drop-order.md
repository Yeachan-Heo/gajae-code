# mem-drop-order

> Know and control drop order: struct fields drop top-to-bottom, locals in reverse

## Why It Matters

Drop order is observable. RAII guards (mutex locks, file handles, database transactions, span guards) do meaningful work in their `Drop` implementations, and dropping them in the wrong order silently causes bugs: releasing a lock while a transaction that depends on it is still alive, closing a connection before its transaction has committed, or dropping a tracing span before the work it covers has finished. The rules are fixed and deterministic, but easy to overlook when fields and locals accumulate over time.

## The Rules

| Construct | Drop order |
|---|---|
| Struct fields | Declaration order: first field declared, first dropped |
| Tuple / array elements | In order: index 0, 1, 2, … |
| Local variables | Reverse declaration order: last declared, first dropped |
| Temporaries in a statement | End of the statement (with some exceptions) |
| Function arguments | Reverse order of the parameter list |

## Bad

```rust
use std::sync::{Mutex, MutexGuard};

struct DatabaseSession {
    // BUG: `guard` is declared first, so it drops FIRST.
    // But `guard` protects the connection — dropping the lock
    // before the transaction is committed lets another thread
    // see the connection in a partial state.
    guard: MutexGuard<'static, ()>,
    transaction: Transaction,
}

struct Transaction; // pretend this commits on drop

impl Drop for Transaction {
    fn drop(&mut self) {
        println!("transaction committed");
    }
}
```

In this struct, `guard` drops before `transaction`, releasing the mutex while the transaction is still in-flight.

## Good

```rust
use std::sync::{Mutex, MutexGuard};

struct Transaction; // commits on drop

impl Drop for Transaction {
    fn drop(&mut self) {
        println!("transaction committed");
    }
}

struct DatabaseSession {
    // CORRECT: `transaction` is declared first, so it drops first
    // (commit happens), THEN `guard` drops (lock released).
    transaction: Transaction,
    guard: MutexGuard<'static, ()>,
}
```

Fields drop in declaration order, so the field at the top of the struct drops first.

## Controlling Drop Order for Locals

Local variables drop in **reverse** declaration order, which is often what you want (last-in, first-out). When the natural order is wrong, use explicit `drop`:

```rust
fn process() {
    let conn = open_connection();   // dropped third (last to drop)
    let txn  = begin_transaction(); // dropped second
    let guard = acquire_lock();     // dropped first — WRONG if txn needs the lock

    // fix: drop guard explicitly before txn and conn drop naturally
    do_work(&txn);
    drop(guard); // lock released here
    txn.commit(); // runs before conn closes
} // conn drops here
# fn open_connection() -> () {}
# fn begin_transaction() -> () {}
# fn acquire_lock() -> () {}
# fn do_work(_: &()) {}
# trait Commit { fn commit(self); }
# impl Commit for () { fn commit(self) {} }
```

## `ManuallyDrop` for Full Control

When you need to opt completely out of automatic drop (e.g., in `unsafe` code, or to move a value out of a struct in `Drop`), use `std::mem::ManuallyDrop`:

```rust
use std::mem::ManuallyDrop;

struct ResourcePair {
    // child must be cleaned up before parent
    child: ManuallyDrop<Child>,
    parent: Parent,
}

impl Drop for ResourcePair {
    fn drop(&mut self) {
        // SAFETY: `child` is not accessed after this point
        unsafe { ManuallyDrop::drop(&mut self.child) };
        // `parent` drops automatically after this block
    }
}

struct Child;
struct Parent;
```

`ManuallyDrop<T>` inhibits the compiler from inserting automatic drop calls, giving you precise control.

## Key Points

- Reorder struct fields to encode the correct drop sequence — the declaration is the contract.
- Add a comment explaining the ordering when it is non-obvious: `// NOTE: drop order matters — transaction before connection`.
- Prefer explicit `drop(x)` calls in functions over relying on scope-exit order when the correct sequence is not immediately clear from the code.
- `std::mem::forget` drops nothing at all (leaks); only use it for FFI hand-off or when transferring ownership to unmanaged code.

## See Also

- [test-fixture-raii](test-fixture-raii.md) - use RAII pattern (Drop) for test cleanup
- [own-mutex-interior](own-mutex-interior.md) - use `Mutex<T>` for interior mutability (multi-thread)
- [mem-take-replace](mem-take-replace.md) - use `mem::take` / `mem::replace` to move out of `&mut`
