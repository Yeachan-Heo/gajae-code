# type-deref-coercion

> Implement `Deref`/`DerefMut` only for smart-pointer and transparent wrapper types

## Why It Matters

`Deref` coercions are what make `Box<T>`, `Arc<T>`, `String`, and `Vec<T>` ergonomic — they let the inner type's methods surface through the wrapper transparently. The Rust API Guidelines (C-DEREF) specify this usage precisely: implement `Deref<Target = T>` when your type *is* a smart pointer or a transparent container for `T`. Using it as an OOP-style inheritance mechanism pollutes method resolution, confuses readers, and makes refactoring hazardous because adding methods to `T` silently affects every wrapper that `Deref`s to it.

## Bad

```rust
struct User {
    name: String,
    email: String,
}

struct AdminUser(User);

// Anti-pattern: using Deref to "inherit" User methods on AdminUser
impl std::ops::Deref for AdminUser {
    type Target = User;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

// Now AdminUser silently exposes all User fields/methods —
// callers can't tell what AdminUser owns vs. inherits.
fn greet(admin: &AdminUser) {
    println!("hello, {}", admin.name); // surprising implicit deref
}
```

## Good

```rust
// Smart-pointer/transparent wrapper: correct use of Deref
struct MyBox<T>(T);

impl<T> std::ops::Deref for MyBox<T> {
    type Target = T;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl<T> std::ops::DerefMut for MyBox<T> {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.0
    }
}

// Domain types: expose only the API you intend, explicitly
struct User {
    pub name: String,
    pub email: String,
}

struct AdminUser(User);

impl AdminUser {
    pub fn name(&self) -> &str {
        &self.0.name
    }

    pub fn email(&self) -> &str {
        &self.0.email
    }

    pub fn can_delete_users(&self) -> bool {
        true
    }
}

fn greet(admin: &AdminUser) {
    println!("hello, {}", admin.name()); // explicit, readable
}
```

## Legitimate Uses

- `Box<T>`, `Rc<T>`, `Arc<T>` — pointer indirection
- `String` → `str`, `Vec<T>` → `[T]` — owned-to-borrowed transparent containers
- `MutexGuard<T>` → `T` — RAII guards that provide temporary access
- Newtype wrappers where the entire semantic purpose is "this is a `T` with additional invariants"

## See Also

- [api-newtype-safety](api-newtype-safety.md) - newtypes for type-safe distinctions without inheritance
- [type-newtype-ids](type-newtype-ids.md) - wrapping IDs in newtypes
- [own-borrow-over-clone](own-borrow-over-clone.md) - prefer `&T` borrowing over `.clone()`
