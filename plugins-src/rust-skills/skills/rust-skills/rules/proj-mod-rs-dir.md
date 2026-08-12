# proj-mod-rs-dir

> Use mod.rs for multi-file modules

## Why It Matters

Rust offers two styles for multi-file modules. The `mod.rs` style is clearer for larger modules and aligns with how most Rust projects are structured. Choose one style consistently.

## Two Styles

### Style 1: mod.rs (Recommended for larger modules)

```
src/
├── user/
│   ├── mod.rs          # Module root
│   ├── model.rs
│   └── repository.rs
└── lib.rs
```

```rust
// src/lib.rs
mod user;  // Looks for user/mod.rs or user.rs

// src/user/mod.rs
mod model;
mod repository;
pub use model::User;
```

### Style 2: Adjacent file (Recommended for smaller modules)

```
src/
├── user.rs             # Module root
├── user/
│   ├── model.rs
│   └── repository.rs
└── lib.rs
```

```rust
// src/lib.rs
mod user;  // Looks for user.rs, then user/ for submodules

// src/user.rs
mod model;
mod repository;
pub use model::User;
```

## When to Use Each

| Scenario | Recommendation |
|----------|----------------|
| Simple module (1-3 submodules) | Adjacent file (`user.rs` + `user/`) |
| Complex module (4+ submodules) | `mod.rs` style (`user/mod.rs`) |
| Deep nesting | `mod.rs` at each level |
| Library with public modules | Consistent style throughout |

## mod.rs Benefits

- Clear that `user/` is a module directory
- All module code inside the folder
- Easier to move/rename entire modules
- Common in large codebases (tokio, serde)

## Adjacent File Benefits

- Module declaration outside directory
- Can see module's interface without entering folder
- Matches Rust 2018+ default lint preference
- Good for small modules with few submodules

## Example: Complex Module

```
src/
├── database/
│   ├── mod.rs          # Main module, re-exports
│   ├── connection.rs   # Connection pool
│   ├── migrations.rs   # Schema migrations
│   ├── queries/        # Sub-module for queries
│   │   ├── mod.rs
│   │   ├── user.rs
│   │   └── order.rs
│   └── error.rs
└── lib.rs
```

```rust
// src/database/mod.rs
mod connection;
mod migrations;
mod queries;
mod error;

pub use connection::Pool;
pub use error::DatabaseError;
pub use queries::{UserQueries, OrderQueries};
```

## Consistency Rule

Pick one style for your project and stick with it:

```rust
// Cargo.toml or clippy.toml
[lints.clippy]
mod_module_files = "warn"  # Enforces mod.rs style
# OR
self_named_module_files = "warn"  # Enforces adjacent style
```

## See Also

- [proj-flat-small](./proj-flat-small.md) - Keep small projects flat
- [proj-mod-by-feature](./proj-mod-by-feature.md) - Feature organization
- [proj-pub-use-reexport](./proj-pub-use-reexport.md) - Re-export patterns
