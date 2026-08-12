# name-into-ownership

> Use `into_` prefix for ownership-consuming conversions

## Why It Matters

The `into_` prefix signals "this method consumes self and returns something else." The original value is moved and no longer usable. This ownership transfer is usually cheap (no allocation), but the caller loses access to the original. Clear naming prevents "use after move" confusion.

## Bad

```rust
impl Wrapper {
    // Misleading: doesn't indicate ownership transfer
    fn get_inner(self) -> Inner {  
        self.inner
    }
    
    // Misleading: suggests borrowing
    fn as_inner(self) -> Inner {  // Takes self by value!
        self.inner
    }
}
```

## Good

```rust
impl Wrapper {
    // into_ clearly shows ownership transfer
    fn into_inner(self) -> Inner {
        self.inner
    }
}

// Usage is clear
let wrapper = Wrapper::new(inner);
let inner = wrapper.into_inner();  // wrapper is consumed
// wrapper.foo();  // Error: use of moved value
```

## Standard Library Examples

```rust
// All consume self and return owned data
let string: String = "hello".to_string();
let bytes: Vec<u8> = string.into_bytes();  // String consumed

let path = PathBuf::from("/foo");
let os_string: OsString = path.into_os_string();  // PathBuf consumed

let boxed: Box<[i32]> = vec![1, 2, 3].into_boxed_slice();  // Vec consumed

let vec: Vec<u8> = boxed.into_vec();  // Box consumed
```

## into_iter() Pattern

```rust
let vec = vec![1, 2, 3];

// into_iter consumes the collection
for item in vec.into_iter() {  // or just: for item in vec
    // item is i32, not &i32
}
// vec is consumed, can't use anymore

// Contrast with iter() which borrows
let vec = vec![1, 2, 3];
for item in vec.iter() {
    // item is &i32
}
// vec still usable
```

## IntoIterator Trait

```rust
impl IntoIterator for MyCollection {
    type Item = Element;
    type IntoIter = std::vec::IntoIter<Element>;
    
    fn into_iter(self) -> Self::IntoIter {
        self.elements.into_iter()  // Consumes self
    }
}
```

## Conversion Prefix Summary

```rust
struct Buffer {
    data: Vec<u8>,
    name: String,
}

impl Buffer {
    // as_ : free borrow, returns reference
    fn as_slice(&self) -> &[u8] {
        &self.data
    }
    
    // to_ : allocates, creates new value
    fn to_vec(&self) -> Vec<u8> {
        self.data.clone()
    }
    
    // into_ : consumes self, usually cheap
    fn into_inner(self) -> Vec<u8> {
        self.data
    }
    
    // into_ : can destructure into parts
    fn into_parts(self) -> (Vec<u8>, String) {
        (self.data, self.name)
    }
}
```

## See Also

- [name-as-free](./name-as-free.md) - Borrowing conversions
- [name-to-expensive](./name-to-expensive.md) - Allocating conversions
- [api-from-not-into](./api-from-not-into.md) - From trait implementation
