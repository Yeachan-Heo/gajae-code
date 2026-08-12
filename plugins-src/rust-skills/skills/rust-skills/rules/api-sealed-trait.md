# api-sealed-trait

> Use sealed traits to prevent external implementations while allowing use

## Why It Matters

Public traits can be implemented by anyone, which may be undesirable when you need to guarantee behavior or add methods in future versions. A sealed trait can be used by external code but not implemented by it, giving you control over implementations while maintaining a usable API.

## Bad

```rust
// Anyone can implement this trait
pub trait DatabaseDriver {
    fn connect(&self, url: &str) -> Connection;
    fn execute(&self, query: &str) -> Result<Rows, Error>;
}

// External crate implements it incorrectly
impl DatabaseDriver for MyBadDriver {
    fn connect(&self, url: &str) -> Connection {
        // Buggy implementation that doesn't handle errors
        unsafe { force_connect(url) }
    }
}

// Later, you want to add a required method - BREAKING CHANGE
pub trait DatabaseDriver {
    fn connect(&self, url: &str) -> Connection;
    fn execute(&self, query: &str) -> Result<Rows, Error>;
    fn transaction(&self) -> Transaction;  // External impls now broken!
}
```

## Good

```rust
// Create a private module with a private trait
mod private {
    pub trait Sealed {}
}

// Public trait requires the private trait
pub trait DatabaseDriver: private::Sealed {
    fn connect(&self, url: &str) -> Connection;
    fn execute(&self, query: &str) -> Result<Rows, Error>;
}

// Only your crate can implement Sealed, thus DatabaseDriver
pub struct PostgresDriver;
impl private::Sealed for PostgresDriver {}
impl DatabaseDriver for PostgresDriver {
    fn connect(&self, url: &str) -> Connection { ... }
    fn execute(&self, query: &str) -> Result<Rows, Error> { ... }
}

pub struct MySqlDriver;
impl private::Sealed for MySqlDriver {}
impl DatabaseDriver for MySqlDriver {
    fn connect(&self, url: &str) -> Connection { ... }
    fn execute(&self, query: &str) -> Result<Rows, Error> { ... }
}

// External crate cannot implement - private::Sealed is not accessible
// impl DatabaseDriver for ExternalDriver { }  // Error!

// But external code CAN use the trait
fn use_driver(driver: &impl DatabaseDriver) {
    let conn = driver.connect("postgres://localhost");
}
```

## Full Pattern

```rust
pub mod db {
    mod private {
        pub trait Sealed {}
    }
    
    /// Database driver trait.
    /// 
    /// This trait is sealed and cannot be implemented outside this crate.
    pub trait Driver: private::Sealed {
        /// Connects to the database.
        fn connect(&self, url: &str) -> Result<Connection, Error>;
        
        /// Executes a query.
        fn execute(&self, sql: &str) -> Result<Rows, Error>;
    }
    
    pub struct Postgres;
    impl private::Sealed for Postgres {}
    impl Driver for Postgres { ... }
    
    pub struct Sqlite;
    impl private::Sealed for Sqlite {}
    impl Driver for Sqlite { ... }
}

// Usage works fine
use db::{Driver, Postgres};

fn query(driver: &impl Driver) {
    driver.execute("SELECT 1")?;
}

query(&Postgres);
```

## Benefits of Sealing

```rust
// 1. Add methods without breaking changes
pub trait Format: private::Sealed {
    fn format(&self) -> String;
    
    // Added later - not breaking because no external impls exist
    fn format_pretty(&self) -> String {
        self.format()  // Default implementation
    }
}

// 2. Guarantee invariants
pub trait SafeBuffer: private::Sealed {
    // You control all implementations, so you know they're all correct
    fn get(&self, index: usize) -> Option<&u8>;
}

// 3. Use as marker traits
pub trait ValidConfig: private::Sealed {}
// Only validated configs implement this
```

## Partially Sealed

```rust
// Allow implementing some methods but not all
mod private {
    pub trait SealedCore {}
}

pub trait Plugin: private::SealedCore {
    // Sealed - only we implement
    fn initialize(&self);
    fn shutdown(&self);
    
    // Open - users can override
    fn name(&self) -> &str { "unnamed" }
}

// Only we can add new required sealed methods
// Users can customize open methods
```

## When to Seal

| Seal When | Don't Seal When |
|-----------|-----------------|
| API stability is critical | You want extension points |
| Implementation correctness is hard | Users need custom implementations |
| You'll add methods later | Trait is simple and stable |
| Safety invariants required | Standard patterns (Iterator, etc.) |

## See Also

- [api-non-exhaustive](./api-non-exhaustive.md) - Related pattern for enums/structs
- [api-extension-trait](./api-extension-trait.md) - Adding methods to external types
- [api-typestate](./api-typestate.md) - Compile-time state guarantees
