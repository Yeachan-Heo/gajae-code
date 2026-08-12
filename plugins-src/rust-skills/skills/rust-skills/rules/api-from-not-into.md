# api-from-not-into

> Implement `From<T>`, not `Into<U>` - From gives you Into for free

## Why It Matters

The standard library has a blanket implementation: `impl<T, U> Into<U> for T where U: From<T>`. This means implementing `From<T> for U` automatically gives you `Into<U> for T`. Implementing `Into` directly bypasses this and is considered non-idiomatic. Always implement `From`.

## Bad

```rust
struct UserId(u64);

// Non-idiomatic: implementing Into directly
impl Into<UserId> for u64 {
    fn into(self) -> UserId {
        UserId(self)
    }
}

// Works, but now you can't use From syntax
let id = UserId::from(42);  // Error: From not implemented
let id: UserId = 42.into(); // Works, but limited
```

## Good

```rust
struct UserId(u64);

// Idiomatic: implement From
impl From<u64> for UserId {
    fn from(id: u64) -> Self {
        UserId(id)
    }
}

// Now both work automatically
let id = UserId::from(42);   // From syntax
let id: UserId = 42.into();  // Into syntax (via blanket impl)

// And Into bound works in generics
fn process(id: impl Into<UserId>) {
    let id: UserId = id.into();
}
process(42u64);  // Works!
```

## Blanket Implementation

```rust
// This is in std, you don't write it
impl<T, U> Into<U> for T
where
    U: From<T>,
{
    fn into(self) -> U {
        U::from(self)
    }
}

// So when you implement From:
impl From<String> for MyType { ... }

// You automatically get:
// impl Into<MyType> for String { ... }
```

## Multiple From Implementations

```rust
struct Email(String);

impl From<String> for Email {
    fn from(s: String) -> Self {
        Email(s)
    }
}

impl From<&str> for Email {
    fn from(s: &str) -> Self {
        Email(s.to_string())
    }
}

// All of these work
let e1 = Email::from("test@example.com");
let e2 = Email::from(String::from("test@example.com"));
let e3: Email = "test@example.com".into();
let e4: Email = String::from("test@example.com").into();
```

## TryFrom for Fallible Conversions

```rust
use std::convert::TryFrom;

struct PositiveInt(u32);

// Fallible conversion
impl TryFrom<i32> for PositiveInt {
    type Error = &'static str;
    
    fn try_from(value: i32) -> Result<Self, Self::Error> {
        if value > 0 {
            Ok(PositiveInt(value as u32))
        } else {
            Err("value must be positive")
        }
    }
}

// Usage
let pos = PositiveInt::try_from(42)?;   // From-style
let pos: PositiveInt = 42.try_into()?;  // Into-style (via blanket)
```

## Clippy Lint

```toml
[lints.clippy]
from_over_into = "warn"  # Warns when implementing Into instead of From
```

```rust
// Clippy will warn:
impl Into<Bar> for Foo {  // Warning: prefer From
    fn into(self) -> Bar { ... }
}
```

## When Into IS Needed (Rare)

```rust
// Only when implementing for external types in specific trait bounds
// This is very rare and usually indicates a design issue

// Example: you can't implement From<ExternalA> for ExternalB
// because of orphan rules. But you usually shouldn't need to.
```

## See Also

- [api-impl-into](./api-impl-into.md) - Using Into in function parameters
- [err-from-impl](./err-from-impl.md) - From for error types
- [api-newtype-safety](./api-newtype-safety.md) - Newtype conversions
- [conv-tryfrom-fallible](./conv-tryfrom-fallible.md) - TryFrom for fallible conversions
- [conv-fromstr-parsing](./conv-fromstr-parsing.md) - FromStr for string parsing
