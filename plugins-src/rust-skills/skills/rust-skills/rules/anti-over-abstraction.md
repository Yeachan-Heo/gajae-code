# anti-over-abstraction

> Don't over-abstract with excessive generics

## Why It Matters

Generics and traits are powerful but come at a cost: compile times, binary size, and cognitive load. Over-abstraction—making everything generic "for flexibility"—often adds complexity without benefit. Start concrete; generalize when you have real use cases.

## Bad

```rust
// Overly generic for a simple function
fn add<T, U, R>(a: T, b: U) -> R
where
    T: Into<R>,
    U: Into<R>,
    R: std::ops::Add<Output = R>,
{
    a.into() + b.into()
}

// Just call add(1, 2) - why make it this complex?

// Trait explosion
trait Readable {}
trait Writable {}
trait ReadWritable: Readable + Writable {}
trait AsyncReadable {}
trait AsyncWritable {}
trait AsyncReadWritable: AsyncReadable + AsyncWritable {}

// Abstract factory pattern (Java flashback)
trait Factory<T> {
    fn create(&self) -> T;
}
trait FactoryFactory<F: Factory<T>, T> {
    fn create_factory(&self) -> F;
}
```

## Good

```rust
// Concrete implementation - clear and simple
fn add_i32(a: i32, b: i32) -> i32 {
    a + b
}

// Generic when actually needed (e.g., library code)
fn add<T: std::ops::Add<Output = T>>(a: T, b: T) -> T {
    a + b
}

// Simple traits for actual polymorphism needs
trait Storage {
    fn save(&self, key: &str, value: &[u8]) -> Result<(), Error>;
    fn load(&self, key: &str) -> Result<Vec<u8>, Error>;
}

// Concrete types first
struct FileStorage { path: PathBuf }
struct MemoryStorage { data: HashMap<String, Vec<u8>> }
```

## Signs of Over-Abstraction

| Sign | Symptom |
|------|---------|
| Single implementation | Generic trait with only one impl |
| Type parameter soup | `T, U, V, W` everywhere |
| Marker traits | Traits with no methods |
| Deep trait bounds | `where T: A + B + C + D + E` |
| Phantom generics | Type parameters not used meaningfully |

## When to Generalize

Generalize when:
- You have 2+ concrete types that share behavior
- You're writing library code for public consumption
- Performance requires static dispatch
- The abstraction simplifies the API

Don't generalize when:
- You "might need it later" (YAGNI)
- Only one type will ever implement it
- It makes code harder to understand

## Rule of Three

Wait until you have three similar concrete implementations before abstracting:

```rust
// Version 1: Just FileStorage
struct FileStorage { /* ... */ }

// Version 2: Added MemoryStorage, similar interface
struct MemoryStorage { /* ... */ }

// Version 3: Now Redis too - time to abstract
trait Storage {
    fn save(&self, key: &str, value: &[u8]) -> Result<()>;
    fn load(&self, key: &str) -> Result<Vec<u8>>;
}
```

## Prefer Concrete Types in Private Code

```rust
// Internal function - concrete type is fine
fn process_orders(db: &PostgresDb, orders: Vec<Order>) { }

// Public API - might benefit from abstraction
pub fn process_orders<S: Storage>(storage: &S, orders: Vec<Order>) { }
```

## See Also

- [type-generic-bounds](./type-generic-bounds.md) - Minimal bounds
- [api-sealed-trait](./api-sealed-trait.md) - Controlled extension
- [anti-type-erasure](./anti-type-erasure.md) - When Box<dyn> is wrong
