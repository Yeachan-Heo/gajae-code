# api-impl-fromiterator

> Implement `FromIterator` and `Extend` for collection types, and `IntoIterator` for all three reference forms

## Why It Matters

The Rust API Guidelines (C-COLLECT) require that collection types implement `FromIterator<T>` so that `iter.collect::<MyCollection<T>>()` works. Pairing it with `Extend<T>` enables efficient batch insertion — the standard library uses `Extend` internally in `collect` when extending an existing collection. Implementing `IntoIterator` for the type itself, for `&Type`, and for `&mut Type` rounds out the contract and lets the collection participate in `for` loops and iterator adapter chains. Skipping these traits forces callers into awkward manual loops and breaks generic code.

## Bad

```rust
struct Bag<T>(Vec<T>);

impl<T> Bag<T> {
    fn new() -> Self { Bag(Vec::new()) }

    fn push(&mut self, item: T) { self.0.push(item); }
}

fn main() {
    // Callers must loop manually — no collect(), no extend(), no for loop
    let mut b = Bag::new();
    for x in [1, 2, 3] {
        b.push(x);
    }
}
```

## Good

```rust
struct Bag<T>(Vec<T>);

impl<T> Bag<T> {
    fn new() -> Self { Bag(Vec::new()) }

    fn push(&mut self, item: T) { self.0.push(item); }

    fn len(&self) -> usize { self.0.len() }

    fn is_empty(&self) -> bool { self.0.is_empty() }
}

// 1. FromIterator — enables .collect::<Bag<T>>()
impl<T> FromIterator<T> for Bag<T> {
    fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
        Bag(iter.into_iter().collect())
    }
}

// 2. Extend — enables .extend(iter) and is used internally by collect
impl<T> Extend<T> for Bag<T> {
    fn extend<I: IntoIterator<Item = T>>(&mut self, iter: I) {
        self.0.extend(iter);
    }
}

// 3a. IntoIterator for owned Bag (consuming)
impl<T> IntoIterator for Bag<T> {
    type Item = T;
    type IntoIter = std::vec::IntoIter<T>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.into_iter()
    }
}

// 3b. IntoIterator for &Bag (borrowing)
impl<'a, T> IntoIterator for &'a Bag<T> {
    type Item = &'a T;
    type IntoIter = std::slice::Iter<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}

// 3c. IntoIterator for &mut Bag (mutable borrowing)
impl<'a, T> IntoIterator for &'a mut Bag<T> {
    type Item = &'a mut T;
    type IntoIter = std::slice::IterMut<'a, T>;

    fn into_iter(self) -> Self::IntoIter {
        self.0.iter_mut()
    }
}

fn main() {
    // collect works
    let b: Bag<i32> = [1, 2, 3].into_iter().collect();
    assert_eq!(b.len(), 3);

    // extend works
    let mut b2 = Bag::new();
    b2.extend([4, 5, 6]);
    assert_eq!(b2.len(), 3);

    // for loop works on &Bag
    for x in &b {
        let _ = x;
    }

    // map/filter chains work via IntoIterator
    let doubled: Bag<i32> = b.into_iter().map(|x| x * 2).collect();
    assert_eq!(doubled.len(), 3);
}
```

## Notes

- If your collection wraps an existing standard container, delegate `from_iter` and `extend` to the inner container's own implementations for maximum efficiency.
- `FromIterator` + `Extend` enable `collect` to call `extend` on a pre-allocated collection when possible, avoiding extra allocations.

## See Also

- [name-iter-convention](name-iter-convention.md) - `iter`/`iter_mut`/`into_iter` method naming
- [perf-collect-once](perf-collect-once.md) - avoid collecting intermediate iterators
- [api-common-traits](api-common-traits.md) - implement `Debug`, `Clone`, `PartialEq` eagerly
