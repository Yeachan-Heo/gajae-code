# name-iter-type-match

> Name iterator types after their source method

## Why It Matters

Iterator types should match the method that creates them. `iter()` returns `Iter`, `into_iter()` returns `IntoIter`, `keys()` returns `Keys`. This naming pattern is established by the standard library and makes types predictable.

## Standard Library Pattern

```rust
// Vec
impl<T> Vec<T> {
    fn iter(&self) -> Iter<'_, T> { }       // Returns Iter
    fn iter_mut(&mut self) -> IterMut<'_, T> { }  // Returns IterMut
}

impl<T> IntoIterator for Vec<T> {
    type IntoIter = IntoIter<T>;  // Returns IntoIter
}

// HashMap
impl<K, V> HashMap<K, V> {
    fn iter(&self) -> Iter<'_, K, V> { }
    fn keys(&self) -> Keys<'_, K, V> { }    // Returns Keys
    fn values(&self) -> Values<'_, K, V> { }  // Returns Values
    fn drain(&mut self) -> Drain<'_, K, V> { }  // Returns Drain
}
```

## Implementation

```rust
mod my_collection {
    pub struct MyCollection<T> {
        items: Vec<T>,
    }
    
    // Iterator types in same module
    pub struct Iter<'a, T> {
        inner: std::slice::Iter<'a, T>,
    }
    
    pub struct IterMut<'a, T> {
        inner: std::slice::IterMut<'a, T>,
    }
    
    pub struct IntoIter<T> {
        inner: std::vec::IntoIter<T>,
    }
    
    impl<T> MyCollection<T> {
        pub fn iter(&self) -> Iter<'_, T> {
            Iter { inner: self.items.iter() }
        }
        
        pub fn iter_mut(&mut self) -> IterMut<'_, T> {
            IterMut { inner: self.items.iter_mut() }
        }
    }
    
    impl<T> IntoIterator for MyCollection<T> {
        type Item = T;
        type IntoIter = IntoIter<T>;
        
        fn into_iter(self) -> IntoIter<T> {
            IntoIter { inner: self.items.into_iter() }
        }
    }
    
    // Implement Iterator for each type
    impl<'a, T> Iterator for Iter<'a, T> {
        type Item = &'a T;
        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next()
        }
    }
    
    impl<'a, T> Iterator for IterMut<'a, T> {
        type Item = &'a mut T;
        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next()
        }
    }
    
    impl<T> Iterator for IntoIter<T> {
        type Item = T;
        fn next(&mut self) -> Option<Self::Item> {
            self.inner.next()
        }
    }
}
```

## Naming Convention

| Method | Iterator Type |
|--------|---------------|
| `iter()` | `Iter` |
| `iter_mut()` | `IterMut` |
| `into_iter()` | `IntoIter` |
| `keys()` | `Keys` |
| `values()` | `Values` |
| `values_mut()` | `ValuesMut` |
| `drain()` | `Drain` |
| `chunks()` | `Chunks` |
| `windows()` | `Windows` |

## Custom Iterator Methods

```rust
impl Graph {
    // Method name -> Type name
    fn nodes(&self) -> Nodes<'_> { }        // Custom: Nodes
    fn edges(&self) -> Edges<'_> { }        // Custom: Edges
    fn neighbors(&self, node: NodeId) -> Neighbors<'_> { }  // Custom: Neighbors
}

pub struct Nodes<'a> { /* ... */ }
pub struct Edges<'a> { /* ... */ }
pub struct Neighbors<'a> { /* ... */ }
```

## Bad

```rust
// Mismatched names
impl MyCollection<T> {
    fn iter(&self) -> MyCollectionIterator<'_, T> { }  // Should be Iter
    fn keys(&self) -> KeyIterator<'_, K> { }           // Should be Keys
}

// Generic names that don't match method
pub struct Iterator<T>;  // Conflicts with std::iter::Iterator
pub struct I<T>;         // Too cryptic
```

## See Also

- [name-iter-convention](./name-iter-convention.md) - iter/iter_mut/into_iter
- [name-iter-method](./name-iter-method.md) - Iterator method names
- [api-common-traits](./api-common-traits.md) - Implementing common traits
