# anti-vec-for-slice

> Don't accept &Vec<T> when &[T] works

## Why It Matters

`&Vec<T>` is strictly less flexible than `&[T]`. A slice can be created from `Vec`, arrays, and other slice-like types. Accepting `&Vec<T>` forces callers to have exactly a `Vec`, preventing them from using arrays, slices, or other collections.

## Bad

```rust
// Forces callers to have a Vec
fn sum(numbers: &Vec<i32>) -> i32 {
    numbers.iter().sum()
}

// Caller must allocate
let arr = [1, 2, 3, 4, 5];
sum(&arr.to_vec());  // Unnecessary allocation

// Slice won't work
let slice: &[i32] = &[1, 2, 3];
// sum(slice);  // Error: expected &Vec<i32>
```

## Good

```rust
// Accept slice - works with Vec, arrays, slices
fn sum(numbers: &[i32]) -> i32 {
    numbers.iter().sum()
}

// All these work
sum(&[1, 2, 3, 4, 5]);        // Array
sum(&vec![1, 2, 3]);          // Vec
sum(&numbers[1..3]);          // Slice of slice
sum(numbers.as_slice());      // Explicit slice
```

## Deref Coercion

`Vec<T>` implements `Deref<Target = [T]>`, so `&Vec<T>` automatically coerces to `&[T]`:

```rust
fn takes_slice(s: &[i32]) { }

let vec = vec![1, 2, 3];
takes_slice(&vec);  // &Vec<i32> -> &[i32] via Deref
```

## Mutable Slices

Same applies to `&mut`:

```rust
// Bad
fn double(numbers: &mut Vec<i32>) {
    for n in numbers.iter_mut() {
        *n *= 2;
    }
}

// Good
fn double(numbers: &mut [i32]) {
    for n in numbers.iter_mut() {
        *n *= 2;
    }
}
```

## When to Accept &Vec<T>

Rarely. Only when you need Vec-specific operations:

```rust
fn needs_capacity(v: &Vec<i32>) -> usize {
    v.capacity()  // Only Vec has capacity
}

fn might_grow(v: &mut Vec<i32>) {
    v.push(42);  // Slice can't push
}
```

## Pattern: Accepting Multiple Types

```rust
// Accept anything that can be viewed as a slice
fn process<T: AsRef<[u8]>>(data: T) {
    let bytes: &[u8] = data.as_ref();
    // ...
}

process(&[1u8, 2, 3]);       // Array
process(vec![1u8, 2, 3]);    // Vec
process(&some_vec);          // &Vec
process(b"bytes");           // Byte string
```

## Similar Anti-patterns

| Anti-pattern | Better |
|--------------|--------|
| `&Vec<T>` | `&[T]` |
| `&String` | `&str` |
| `&PathBuf` | `&Path` |
| `&Box<T>` | `&T` |

## Clippy Detection

```toml
[lints.clippy]
ptr_arg = "warn"  # Catches &Vec, &String, &PathBuf
```

## See Also

- [anti-string-for-str](./anti-string-for-str.md) - Similar for String
- [own-slice-over-vec](./own-slice-over-vec.md) - Slice patterns
- [api-impl-asref](./api-impl-asref.md) - AsRef pattern
