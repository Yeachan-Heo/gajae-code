# anti-type-erasure

> Don't use Box<dyn Trait> when impl Trait works

## Why It Matters

`Box<dyn Trait>` (type erasure) introduces heap allocation and dynamic dispatch overhead. When you have a single concrete type or can use generics, `impl Trait` provides the same flexibility with zero overhead through monomorphization.

## Bad

```rust
// Unnecessary type erasure
fn get_iterator() -> Box<dyn Iterator<Item = i32>> {
    Box::new((0..10).map(|x| x * 2))
}

// Boxing for no reason
fn make_handler() -> Box<dyn Fn(i32) -> i32> {
    Box::new(|x| x + 1)
}

// Vec of boxed trait objects when one type would do
fn get_validators() -> Vec<Box<dyn Validator>> {
    vec![
        Box::new(LengthValidator),
        Box::new(RegexValidator),
    ]
}
```

## Good

```rust
// impl Trait - zero overhead, inlined
fn get_iterator() -> impl Iterator<Item = i32> {
    (0..10).map(|x| x * 2)
}

// impl Fn - no boxing
fn make_handler() -> impl Fn(i32) -> i32 {
    |x| x + 1
}

// When mixed types are genuinely needed, Box is OK
fn get_validators() -> Vec<Box<dyn Validator>> {
    // Actually different types at runtime - Box is appropriate
    config.validators.iter()
        .map(|v| v.create_validator())
        .collect()
}
```

## When to Use Box<dyn Trait>

Type erasure IS appropriate when:

```rust
// Heterogeneous collection of different types
let handlers: Vec<Box<dyn Handler>> = vec![
    Box::new(LogHandler),
    Box::new(MetricsHandler),
    Box::new(AuthHandler),
];

// Type cannot be known at compile time
fn create_from_config(config: &Config) -> Box<dyn Database> {
    match config.db_type {
        DbType::Postgres => Box::new(PostgresDb::new()),
        DbType::Sqlite => Box::new(SqliteDb::new()),
    }
}

// Recursive types
struct Node {
    value: i32,
    children: Vec<Box<dyn NodeTrait>>,
}

// Breaking cycles in complex ownership
struct EventLoop {
    handlers: Vec<Box<dyn EventHandler>>,
}
```

## Comparison

| Approach | Allocation | Dispatch | Binary Size |
|----------|------------|----------|-------------|
| `impl Trait` | Stack/inline | Static | Larger (monomorphization) |
| `Box<dyn Trait>` | Heap | Dynamic | Smaller |
| Generics `<T>` | Stack/inline | Static | Larger |

## impl Trait Positions

```rust
// Return position - caller doesn't need to know concrete type
fn process() -> impl Future<Output = Result> { }

// Argument position - like generics but simpler
fn handle(handler: impl Handler) { }

// Return-position impl Trait in traits (RPITIT) is stable since Rust 1.75
trait Processor {
    // Use impl Trait when callers don't need to name the return type:
    fn process(&self) -> impl Display;  // stable, idiomatic (Rust 1.75+)

    // Use an associated type when callers need to name or constrain the type:
    type Output: Display;
    fn process_named(&self) -> Self::Output;
}
```

## Pattern: Enum Instead of dyn

```rust
// Instead of Box<dyn Shape>
enum Shape {
    Circle { radius: f64 },
    Rectangle { width: f64, height: f64 },
    Triangle { base: f64, height: f64 },
}

impl Shape {
    fn area(&self) -> f64 {
        match self {
            Shape::Circle { radius } => PI * radius * radius,
            Shape::Rectangle { width, height } => width * height,
            Shape::Triangle { base, height } => 0.5 * base * height,
        }
    }
}
```

## See Also

- [anti-over-abstraction](./anti-over-abstraction.md) - Excessive generics
- [type-generic-bounds](./type-generic-bounds.md) - Generic constraints
- [mem-box-large-variant](./mem-box-large-variant.md) - Boxing enum variants
- [trait-dyn-vs-generic](./trait-dyn-vs-generic.md) - Choose dispatch deliberately
- [closure-static-vs-dyn](./closure-static-vs-dyn.md) - Same tradeoff for closures
