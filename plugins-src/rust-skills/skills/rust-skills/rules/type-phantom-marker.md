# type-phantom-marker

> Use `PhantomData` to express type relationships without runtime cost

## Why It Matters

Sometimes your type needs to be parameterized by a type that doesn't appear in any field—for variance, drop order, or semantic purposes. `PhantomData<T>` tells the compiler your type is "associated with" `T` without storing any `T` data. It has zero runtime cost.

## Bad

```rust
// Type parameter unused - compiler error
struct Handle<T> {
    id: u64,
    // Error: parameter `T` is never used
}

// Workaround with unnecessary storage
struct Handle<T> {
    id: u64,
    _type: Option<T>,  // Wastes memory, requires T: Default
}
```

## Good

```rust
use std::marker::PhantomData;

struct Handle<T> {
    id: u64,
    _marker: PhantomData<T>,  // Zero-size, tells compiler about T
}

impl<T> Handle<T> {
    fn new(id: u64) -> Self {
        Handle {
            id,
            _marker: PhantomData,
        }
    }
}

// Different Handle types are incompatible
struct User;
struct Order;

fn process_user(h: Handle<User>) { ... }

let user_handle = Handle::<User>::new(1);
let order_handle = Handle::<Order>::new(2);

process_user(user_handle);   // OK
process_user(order_handle);  // Error: expected Handle<User>, found Handle<Order>
```

## Expressing Ownership

```rust
use std::marker::PhantomData;

// Owns T conceptually (like Box<T>)
struct Container<T> {
    ptr: *mut T,
    _marker: PhantomData<T>,  // Acts like we own a T
}

// Drop will be called on T when Container drops
impl<T> Drop for Container<T> {
    fn drop(&mut self) {
        unsafe {
            std::ptr::drop_in_place(self.ptr);
        }
    }
}
```

## Expressing Borrowing

```rust
use std::marker::PhantomData;

// Borrows T for lifetime 'a
struct Ref<'a, T> {
    ptr: *const T,
    _marker: PhantomData<&'a T>,  // Acts like &'a T
}

// Compiler tracks lifetime correctly
impl<'a, T> Ref<'a, T> {
    fn get(&self) -> &'a T {
        unsafe { &*self.ptr }
    }
}
```

## Type-Level State Machine

```rust
use std::marker::PhantomData;

// States as zero-size types
struct Unlocked;
struct Locked;

struct Door<State> {
    _state: PhantomData<State>,
}

impl Door<Unlocked> {
    fn lock(self) -> Door<Locked> {
        println!("Locking...");
        Door { _state: PhantomData }
    }
    
    fn open(&self) {
        println!("Opening...");
    }
}

impl Door<Locked> {
    fn unlock(self) -> Door<Unlocked> {
        println!("Unlocking...");
        Door { _state: PhantomData }
    }
    
    // Can't call open() on Locked door - method doesn't exist
}

fn example() {
    let door: Door<Unlocked> = Door { _state: PhantomData };
    door.open();           // OK
    let locked = door.lock();
    // locked.open();      // Error: no method `open` for Door<Locked>
    let unlocked = locked.unlock();
    unlocked.open();       // OK
}
```

## Variance Control

```rust
use std::marker::PhantomData;

// Covariant in T (PhantomData<T>)
struct Producer<T> {
    _marker: PhantomData<T>,  // Covariant
}

// Contravariant in T (PhantomData<fn(T)>)
struct Consumer<T> {
    _marker: PhantomData<fn(T)>,  // Contravariant
}

// Invariant in T (PhantomData<fn(T) -> T>)
struct Both<T> {
    _marker: PhantomData<fn(T) -> T>,  // Invariant
}
```

## Common Uses

```rust
// 1. FFI handles with type safety
struct FileHandle<T: FileType> {
    fd: i32,
    _marker: PhantomData<T>,
}

// 2. Generic iterators
struct Iter<'a, T> {
    ptr: *const T,
    end: *const T,
    _marker: PhantomData<&'a T>,
}

// 3. Allocator-aware types
struct Vec<T, A: Allocator = Global> {
    buf: RawVec<T, A>,
    len: usize,
}
```

## See Also

- [api-typestate](./api-typestate.md) - State machine pattern
- [api-newtype-safety](./api-newtype-safety.md) - Type-safe wrappers
- [type-newtype-ids](./type-newtype-ids.md) - ID types
