# anti-string-for-str

> Don't accept &String when &str works

## Why It Matters

`&String` is strictly less flexible than `&str`. A `&str` can be created from `String`, `&str`, literals, and slices. A `&String` requires exactly a `String`. This forces callers to allocate when they might not need to.

## Bad

```rust
// Forces callers to have a String
fn greet(name: &String) {
    println!("Hello, {}", name);
}

// Caller must allocate
greet(&"Alice".to_string());  // Unnecessary allocation
greet(&name);                 // Only works if name is String

// In struct
struct Config {
    name: String,
}

impl Config {
    fn set_name(&mut self, name: &String) {  // Too restrictive
        self.name = name.clone();
    }
}
```

## Good

```rust
// Accept &str - works with String, &str, literals
fn greet(name: &str) {
    println!("Hello, {}", name);
}

// All these work
greet("Alice");           // String literal
greet(&name);             // &String coerces to &str
greet(name.as_str());     // Explicit &str

// In struct
impl Config {
    fn set_name(&mut self, name: &str) {
        self.name = name.to_string();
    }
    
    // Or accept owned String if caller usually has one
    fn set_name_owned(&mut self, name: String) {
        self.name = name;
    }
    
    // Or be generic
    fn set_name_into(&mut self, name: impl Into<String>) {
        self.name = name.into();
    }
}
```

## Deref Coercion

`String` implements `Deref<Target = str>`, so `&String` automatically coerces to `&str`:

```rust
fn takes_str(s: &str) { }

let owned = String::from("hello");
takes_str(&owned);  // &String -> &str via Deref
```

## When to Accept &String

Rarely. Maybe if you need `String`-specific methods:

```rust
fn needs_capacity(s: &String) -> usize {
    s.capacity()  // Only String has capacity()
}
```

But usually you'd take `&str` and let the caller manage the `String`.

## Pattern: Flexible APIs

```rust
// Most flexible: accept anything that can become &str
fn process(input: impl AsRef<str>) {
    let s: &str = input.as_ref();
    // ...
}

process("literal");
process(String::from("owned"));
process(&some_string);
```

## Similar Anti-patterns

| Anti-pattern | Better |
|--------------|--------|
| `&String` | `&str` |
| `&Vec<T>` | `&[T]` |
| `&Box<T>` | `&T` |
| `&PathBuf` | `&Path` |
| `&OsString` | `&OsStr` |

## Clippy Detection

```toml
[lints.clippy]
ptr_arg = "warn"  # Catches &String, &Vec, &PathBuf
```

## See Also

- [anti-vec-for-slice](./anti-vec-for-slice.md) - Similar pattern for Vec
- [own-slice-over-vec](./own-slice-over-vec.md) - Slice patterns
- [api-impl-asref](./api-impl-asref.md) - AsRef pattern
