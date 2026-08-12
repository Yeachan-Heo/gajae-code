# name-iter-convention

> Use iter/iter_mut/into_iter for iterator methods

## Why It Matters

Rust has a standard convention for iterator method names that signals ownership semantics. Following this convention makes APIs predictable and enables the `for item in collection` syntax to work correctly.

## The Three Iterator Methods

| Method | Returns | Ownership |
|--------|---------|-----------|
| `iter()` | `impl Iterator<Item = &T>` | Borrows collection |
| `iter_mut()` | `impl Iterator<Item = &mut T>` | Mutably borrows |
| `into_iter()` | `impl Iterator<Item = T>` | Consumes collection |

## Implementation

```rust
struct MyCollection<T> {
    items: Vec<T>,
}

impl<T> MyCollection<T> {
    /// Returns an iterator over references.
    fn iter(&self) -> impl Iterator<Item = &T> {
        self.items.iter()
    }
    
    /// Returns an iterator over mutable references.
    fn iter_mut(&mut self) -> impl Iterator<Item = &mut T> {
        self.items.iter_mut()
    }
}

// IntoIterator trait for into_iter()
impl<T> IntoIterator for MyCollection<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.into_iter()
    }
}

// Also implement for references
impl<'a, T> IntoIterator for &'a MyCollection<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut MyCollection<T> {
    type Item = &'a mut T;
    type IntoIter = std::slice::IterMut<'a, T>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.items.iter_mut()
    }
}
```

## Usage

```rust
let collection = MyCollection { items: vec![1, 2, 3] };

// Explicit methods
for x in collection.iter() { }     // Borrows
for x in collection.iter_mut() { } // Mutably borrows

// IntoIterator enables for loop syntax
for x in &collection { }      // Calls (&collection).into_iter()
for x in &mut collection { }  // Calls (&mut collection).into_iter()
for x in collection { }       // Consumes, calls collection.into_iter()
```

## Bad

```rust
impl MyCollection<T> {
    // Non-standard names
    fn elements(&self) -> impl Iterator<Item = &T> { }      // Should be iter()
    fn get_items(&self) -> impl Iterator<Item = &T> { }     // Should be iter()
    fn iterate(&self) -> impl Iterator<Item = &T> { }       // Should be iter()
    fn as_iter(&self) -> impl Iterator<Item = &T> { }       // Should be iter()
}
```

## Additional Iterator Methods

```rust
impl MyCollection<T> {
    // Filter by predicate
    fn iter_valid(&self) -> impl Iterator<Item = &T> {
        self.iter().filter(|x| x.is_valid())
    }
    
    // Specific slice
    fn iter_range(&self, start: usize, end: usize) -> impl Iterator<Item = &T> {
        self.items[start..end].iter()
    }
}
```

## Standard Library Examples

```rust
// Vec, slice, arrays
vec.iter()      // &T
vec.iter_mut()  // &mut T
vec.into_iter() // T

// HashMap
map.iter()      // (&K, &V)
map.iter_mut()  // (&K, &mut V)
map.into_iter() // (K, V)
map.keys()      // &K
map.values()    // &V
```

## See Also

- [name-iter-type-match](./name-iter-type-match.md) - Iterator type naming
- [name-iter-method](./name-iter-method.md) - Iterator method names
- [perf-iter-over-index](./perf-iter-over-index.md) - Prefer iterators
