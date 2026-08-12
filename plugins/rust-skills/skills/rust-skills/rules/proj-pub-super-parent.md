# proj-pub-super-parent

> Use pub(super) for parent-only visibility

## Why It Matters

`pub(super)` exposes items only to the immediate parent module. This is useful for helper functions and types that submodules share but shouldn't be visible to the rest of the crate.

## Bad

```rust
// src/parser/mod.rs
pub mod lexer;
pub mod ast;

// src/parser/lexer.rs
pub fn internal_helper() {  // Visible to entire crate!
    // Helper only needed by lexer and ast
}

pub(crate) struct Token {  // Visible to entire crate
    // Only parser submodules need this
}
```

## Good

```rust
// src/parser/mod.rs
pub mod lexer;
pub mod ast;

// Shared types for parser submodules only
pub(super) struct Token {
    pub(super) kind: TokenKind,
    pub(super) span: Span,
}

pub(super) fn shared_helper() -> Token {
    // Only visible in parser/*
}

// src/parser/lexer.rs
use super::{Token, shared_helper};

pub fn lex(input: &str) -> Vec<Token> {
    shared_helper();
    // ...
}

// src/parser/ast.rs
use super::Token;

pub fn parse(tokens: Vec<Token>) -> Ast {
    // ...
}
```

## Visibility Hierarchy

```
src/
├── lib.rs           # crate root
├── parser/
│   ├── mod.rs       # pub(super) items visible here
│   ├── lexer.rs     # can use pub(super) from mod.rs
│   └── ast.rs       # can use pub(super) from mod.rs
└── codegen.rs       # CANNOT see pub(super) parser items
```

## Pattern: Layered Visibility

```rust
// src/database/mod.rs
mod connection;
mod query;
mod pool;

// Only this module's children can see
pub(super) struct RawConnection { /* ... */ }

// Entire crate can see
pub(crate) struct Pool { /* ... */ }

// Everyone can see
pub struct Database { /* ... */ }
```

## Pattern: Test Helpers

```rust
// src/parser/mod.rs
mod lexer;
mod ast;

#[cfg(test)]
mod tests {
    use super::*;
    
    // Test helper visible only to parser module's tests
    pub(super) fn make_test_token() -> Token {
        Token { kind: TokenKind::Test, span: Span::dummy() }
    }
}

// src/parser/lexer.rs
#[cfg(test)]
mod tests {
    use super::super::tests::make_test_token;
    // ...
}
```

## Comparison

| Visibility | Scope | Use Case |
|------------|-------|----------|
| `pub` | Everywhere | Public API |
| `pub(crate)` | Crate-wide | Internal shared utilities |
| `pub(super)` | Parent module | Submodule helpers |
| `pub(in path)` | Specific path | Precise control |
| (private) | Current module | Implementation details |

## When to Use pub(super)

- Helper functions shared between sibling modules
- Types used by submodules but not the rest of crate
- Implementation details of a module group
- Test utilities for a module tree

## See Also

- [proj-pub-crate-internal](./proj-pub-crate-internal.md) - Crate visibility
- [proj-pub-use-reexport](./proj-pub-use-reexport.md) - Re-export patterns
- [proj-mod-by-feature](./proj-mod-by-feature.md) - Feature organization
