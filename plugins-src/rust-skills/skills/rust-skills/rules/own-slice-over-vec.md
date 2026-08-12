# own-slice-over-vec

> Accept `&[T]` not `&Vec<T>`, `&str` not `&String`

## Why It Matters

Accepting `&[T]` instead of `&Vec<T>` makes your function more flexible - it can accept slices from arrays, vectors, or other sources. Similarly, `&str` accepts string slices from `String`, `&'static str`, or substrings.

## Bad

```rust
// Overly restrictive - only accepts &Vec
fn sum(numbers: &Vec<i32>) -> i32 {
    numbers.iter().sum()
}

// Overly restrictive - only accepts &String
fn greet(name: &String) {
    println!("Hello, {}", name);
}

// Can't call with arrays or slices
let arr = [1, 2, 3];
// sum(&arr);  // ERROR: expected &Vec<i32>

let literal = "world";
// greet(&literal);  // ERROR: expected &String
```

## Good

```rust
// Flexible - accepts any slice-like thing
fn sum(numbers: &[i32]) -> i32 {
    numbers.iter().sum()
}

// Flexible - accepts any string-like thing
fn greet(name: &str) {
    println!("Hello, {}", name);
}

// Now all of these work:
let vec = vec![1, 2, 3];
let arr = [4, 5, 6];
let slice = &vec[0..2];

sum(&vec);    // Vec coerces to slice
sum(&arr);    // Array coerces to slice
sum(slice);   // Slice works directly

let string = String::from("Alice");
let literal = "Bob";

greet(&string);  // String coerces to &str
greet(literal);  // &str works directly
```

## The Deref Coercion Chain

```rust
// These coercions happen automatically:
// Vec<T>  -> &[T]   (via Deref)
// String  -> &str   (via Deref)
// Box<T>  -> &T     (via Deref)
// Arc<T>  -> &T     (via Deref)

fn process(data: &[u8]) { /* ... */ }

let vec: Vec<u8> = vec![1, 2, 3];
let boxed: Box<[u8]> = vec.into_boxed_slice();
let arc: Arc<[u8]> = Arc::from(&[1, 2, 3][..]);

process(&vec);    // Works
process(&boxed);  // Works
process(&arc);    // Works
```

## Path Types Too

```rust
// Bad
fn read_config(path: &PathBuf) -> Config { /* ... */ }

// Good - accepts &Path, &PathBuf, &str, &String
fn read_config(path: &Path) -> Config { /* ... */ }

// Even better - accept anything path-like
fn read_config(path: impl AsRef<Path>) -> Config {
    let path = path.as_ref();
    // ...
}
```

## When to Accept Owned Types

```rust
// Accept owned when you need to store it
struct Logger {
    prefix: String,  // Needs to own the string
}

impl Logger {
    // Take ownership - caller decides to clone or move
    fn new(prefix: String) -> Self {
        Self { prefix }
    }
    
    // Or use Into for flexibility
    fn with_prefix(prefix: impl Into<String>) -> Self {
        Self { prefix: prefix.into() }
    }
}
```

## See Also

- [api-impl-asref](api-impl-asref.md) - Accept `impl AsRef<T>` for maximum flexibility
- [own-borrow-over-clone](own-borrow-over-clone.md) - Prefer borrowing over cloning
