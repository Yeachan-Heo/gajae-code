# lint-missing-docs

> Warn on missing documentation for public items

## Why It Matters

The `missing_docs` lint ensures all public API items are documented. For libraries, documentation IS the user interface. Missing docs mean users can't understand your API without reading source code.

## Configuration

```rust
// In lib.rs
#![warn(missing_docs)]
```

Or in `Cargo.toml`:

```toml
[lints.rust]
missing_docs = "warn"
```

For strict enforcement:

```rust
#![deny(missing_docs)]
```

## What It Catches

```rust
#![warn(missing_docs)]

pub struct User {  // WARN: missing documentation for a struct
    pub name: String,  // WARN: missing documentation for a field
    pub age: u32,      // WARN: missing documentation for a field
}

pub fn process() { }  // WARN: missing documentation for a function

pub trait Handler {  // WARN: missing documentation for a trait
    fn handle(&self);  // WARN: missing documentation for a method
}
```

## Good

```rust
#![warn(missing_docs)]

//! User management module.

/// Represents a registered user in the system.
pub struct User {
    /// The user's display name.
    pub name: String,
    /// The user's age in years.
    pub age: u32,
}

/// Processes pending user requests.
///
/// # Examples
///
/// ```
/// process();
/// ```
pub fn process() { }

/// Handler trait for request processing.
pub trait Handler {
    /// Handle an incoming request.
    fn handle(&self);
}
```

## Private Items

`missing_docs` only applies to `pub` items. Private items don't trigger warnings:

```rust
#![warn(missing_docs)]

struct Internal { }  // No warning - private

pub struct Public { }  // WARN - public, needs docs
```

## Allow for Specific Items

```rust
#![warn(missing_docs)]

/// Documented module.
pub mod api {
    /// Documented struct.
    pub struct Config { }
    
    #[allow(missing_docs)]
    pub mod internal {
        // Internal API, docs not required
        pub struct Helper { }
    }
}
```

## Gradual Adoption

For existing codebases, start with `warn` and fix incrementally:

```rust
// Phase 1: Warn, fix critical items
#![warn(missing_docs)]

// Phase 2: After cleanup, deny
#![deny(missing_docs)]
```

## Combining with doc Attributes

```rust
#![warn(missing_docs)]
#![warn(rustdoc::broken_intra_doc_links)]
#![warn(rustdoc::private_intra_doc_links)]
```

## Workspace Configuration

```toml
# In workspace Cargo.toml
[workspace.lints.rust]
missing_docs = "warn"

# Member crates inherit
[lints]
workspace = true
```

## What to Document

| Item | Doc Focus |
|------|-----------|
| Structs | Purpose, usage example |
| Struct fields | What it represents |
| Enums | When to use each variant |
| Functions | What it does, params, return |
| Traits | Contract and expectations |
| Modules | What the module provides |

## See Also

- [doc-all-public](./doc-all-public.md) - Documentation patterns
- [lint-unsafe-doc](./lint-unsafe-doc.md) - Unsafe documentation
- [doc-examples-section](./doc-examples-section.md) - Adding examples
