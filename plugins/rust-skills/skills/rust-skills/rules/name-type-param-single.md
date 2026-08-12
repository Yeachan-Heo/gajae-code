# name-type-param-single

> Use single uppercase letters for type parameters: `T`, `E`, `K`, `V`

## Why It Matters

Generic type parameters conventionally use single uppercase letters. This keeps signatures concise and follows established conventions that readers instantly recognize. `T` for "type", `E` for "error", `K` for "key", `V` for "value" are universal in Rust.

## Bad

```rust
// Verbose type parameters
struct Container<ElementType> {
    items: Vec<ElementType>,
}

fn process<InputType, OutputType>(input: InputType) -> OutputType { ... }

// Lowercase - looks like lifetime
struct Wrapper<t> { ... }  // Confusing
```

## Good

```rust
// Single uppercase letters
struct Container<T> {
    items: Vec<T>,
}

fn process<I, O>(input: I) -> O { ... }

// Standard conventions
struct HashMap<K, V> { ... }     // K=Key, V=Value
enum Result<T, E> { ... }         // T=Type, E=Error
enum Option<T> { ... }            // T=Type
struct Ref<'a, T> { ... }        // Lifetime + Type
```

## Standard Type Parameter Names

| Parameter | Meaning | Example |
|-----------|---------|---------|
| `T` | Type (generic) | `Vec<T>` |
| `E` | Error | `Result<T, E>` |
| `K` | Key | `HashMap<K, V>` |
| `V` | Value | `HashMap<K, V>` |
| `I` | Input / Item | `Iterator<Item = I>` |
| `O` | Output | `Fn(I) -> O` |
| `R` | Return / Result | `fn() -> R` |
| `S` | State | `StateMachine<S>` |
| `A` | Allocator | `Vec<T, A>` |
| `F` | Function | `map<F>(f: F)` |

## Multiple Type Parameters

```rust
// Use related letters
fn transform<I, O, E>(input: I) -> Result<O, E>
where
    I: Input,
    O: Output,
    E: Error,
{ ... }

// Or sequential: T, U, V
fn combine<T, U, V>(a: T, b: U) -> V { ... }

// Descriptive only when many parameters need clarity
struct Query<Db, Row, Err> { ... }
```

## Trait Bounds

```rust
// Keep type params short, move complexity to where clause
fn process<T, E>(value: T) -> Result<T, E>
where
    T: Clone + Debug + Send + Sync,
    E: Error + From<IoError>,
{ ... }

// Not inline
fn process<T: Clone + Debug + Send + Sync, E: Error + From<IoError>>(value: T) -> Result<T, E>
// Too long!
```

## See Also

- [name-lifetime-short](./name-lifetime-short.md) - Lifetime parameter naming
- [name-types-camel](./name-types-camel.md) - Concrete type naming
- [type-generic-bounds](./type-generic-bounds.md) - Trait bounds
