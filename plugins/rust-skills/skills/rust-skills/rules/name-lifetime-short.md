# name-lifetime-short

> Use short, conventional lifetime names: `'a`, `'b`, `'de`, `'src`

## Why It Matters

Lifetime parameters are ubiquitous in Rust signatures. Short names like `'a` keep signatures readable. For domain-specific lifetimes, descriptive but short names like `'src` or `'de` communicate intent without clutter. The Rust community has established conventions that aid recognition.

## Bad

```rust
// Overly verbose lifetimes
fn parse<'input_lifetime, 'output_lifetime>(
    input: &'input_lifetime str
) -> Result<&'output_lifetime str, Error> { ... }

// Meaningless long names
struct Parser<'parser_instance_lifetime> {
    source: &'parser_instance_lifetime str,
}
```

## Good

```rust
// Standard short lifetimes
fn parse<'a>(input: &'a str) -> Result<&'a str, Error> { ... }

struct Parser<'a> {
    source: &'a str,
}

// Multiple lifetimes: 'a, 'b, 'c
fn merge<'a, 'b>(first: &'a str, second: &'b str) -> String { ... }

// Descriptive when clarity helps
fn deserialize<'de>(input: &'de [u8]) -> Result<Value<'de>, Error> { ... }
```

## Common Lifetime Conventions

| Lifetime | Convention | Example |
|----------|------------|---------|
| `'a` | Generic, first lifetime | `fn foo<'a>(x: &'a str)` |
| `'b` | Generic, second lifetime | `fn bar<'a, 'b>(x: &'a T, y: &'b U)` |
| `'de` | Deserialization | serde's `Deserialize<'de>` |
| `'src` | Source code/input | `struct Lexer<'src>` |
| `'ctx` | Context | `struct Query<'ctx>` |
| `'input` | Input data | `struct Parser<'input>` |
| `'static` | Static lifetime | `&'static str` |

## Elision Preferred

```rust
// Let elision work when possible
fn first_word(s: &str) -> &str {  // Not fn first_word<'a>(s: &'a str) -> &'a str
    s.split_whitespace().next().unwrap_or("")
}

impl User {
    fn name(&self) -> &str {  // Elision handles this
        &self.name
    }
}
```

## Serde Convention

```rust
use serde::{Deserialize, Serialize};

// 'de is the standard serde lifetime for borrowed data
#[derive(Deserialize)]
struct Request<'de> {
    #[serde(borrow)]
    name: &'de str,
    #[serde(borrow)]
    tags: Vec<&'de str>,
}
```

## See Also

- [own-lifetime-elision](./own-lifetime-elision.md) - When to omit lifetimes
- [name-type-param-single](./name-type-param-single.md) - Type parameter naming
- [own-borrow-over-clone](./own-borrow-over-clone.md) - Borrowing patterns
