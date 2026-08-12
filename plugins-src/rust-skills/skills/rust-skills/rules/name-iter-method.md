# name-iter-method

> Name iterator methods `iter()`, `iter_mut()`, and `into_iter()` consistently

## Why It Matters

Rust has a strong convention for iterator method names. Following these conventions makes your types work predictably with `for` loops and iterator adapters. Users expect `iter()` for shared references, `iter_mut()` for mutable references, and `into_iter()` for owned iteration.

## Bad

```rust
struct Collection<T> {
    items: Vec<T>,
}

impl<T> Collection<T> {
    // Non-standard names - confusing
    fn elements(&self) -> impl Iterator<Item = &T> {
        self.items.iter()
    }
    
    fn get_iterator(&self) -> impl Iterator<Item = &T> {
        self.items.iter()
    }
    
    fn to_iter(self) -> impl Iterator<Item = T> {
        self.items.into_iter()
    }
}
```

## Good

```rust
struct Collection<T> {
    items: Vec<T>,
}

impl<T> Collection<T> {
    /// Returns an iterator over references.
    fn iter(&self) -> impl Iterator<Item = &T> {
        self.items.iter()
    }
    
    /// Returns an iterator over mutable references.
    fn iter_mut(&mut self) -> impl Iterator<Item = &mut T> {
        self.items.iter_mut()
    }
}

// Implement IntoIterator for for-loop support
impl<T> IntoIterator for Collection<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.into_iter()
    }
}

impl<'a, T> IntoIterator for &'a Collection<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Collection<T> {
    type Item = &'a mut T;
    type IntoIter = std::slice::IterMut<'a, T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter_mut()
    }
}
```

## Iterator Convention Summary

| Method | Receiver | Yields | Use Case |
|--------|----------|--------|----------|
| `iter()` | `&self` | `&T` | Read-only iteration |
| `iter_mut()` | `&mut self` | `&mut T` | In-place modification |
| `into_iter()` | `self` | `T` | Consuming iteration |

## For Loop Integration

```rust
let col = Collection { items: vec![1, 2, 3] };

// These all work with proper IntoIterator impls
for item in &col {           // Calls (&col).into_iter() -> iter()
    println!("{}", item);    // &i32
}

for item in &mut col {       // Calls (&mut col).into_iter() -> iter_mut()
    *item += 1;              // &mut i32
}

for item in col {            // Calls col.into_iter()
    process(item);           // i32, consumes col
}
```

## Additional Iterator Methods

```rust
impl<T> Collection<T> {
    // Domain-specific iterators follow similar patterns
    
    /// Iterates over keys (for map-like structures).
    fn keys(&self) -> impl Iterator<Item = &K> { ... }
    
    /// Iterates over values.
    fn values(&self) -> impl Iterator<Item = &V> { ... }
    
    /// Iterates over mutable values.
    fn values_mut(&mut self) -> impl Iterator<Item = &mut V> { ... }
    
    /// Drains elements, leaving container empty.
    fn drain(&mut self) -> impl Iterator<Item = T> { ... }
}
```

## See Also

- [name-as-free](./name-as-free.md) - Conversion naming conventions
- [api-extension-trait](./api-extension-trait.md) - Iterator extensions
- [api-common-traits](./api-common-traits.md) - Standard trait implementations
