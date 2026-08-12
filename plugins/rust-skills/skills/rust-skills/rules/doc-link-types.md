# doc-link-types

> Use intra-doc links to connect related types and functions

## Why It Matters

Intra-doc links (`[`TypeName`]`) create clickable references in generated documentation. They enable navigation between related items, verify that referenced items exist at compile time, and update automatically when items are renamed. Plain text references become stale and unclickable.

## Bad

```rust
/// Parses input and returns a ParseResult.
/// 
/// See also: ParseError for error types.
/// Uses the Tokenizer internally.
pub fn parse(input: &str) -> ParseResult {
    // "ParseResult", "ParseError", "Tokenizer" are not clickable
    // No verification they exist
}
```

## Good

```rust
/// Parses input and returns a [`ParseResult`].
///
/// # Errors
///
/// Returns [`ParseError::InvalidSyntax`] if the input contains invalid tokens.
/// Returns [`ParseError::UnexpectedEof`] if the input ends prematurely.
///
/// # Related
///
/// - [`Tokenizer`] - The underlying tokenizer used by this parser
/// - [`parse_file`] - Convenience function for parsing files
/// - [`ParseOptions`] - Configuration options for parsing
pub fn parse(input: &str) -> ParseResult {
    // All links are clickable and verified
}
```

## Link Syntax

```rust
/// Basic link to type in same module
/// See [`MyType`] for details.

/// Link to method
/// Use [`MyType::new`] to create instances.

/// Link to associated type
/// Returns [`Iterator::Item`].

/// Link to module
/// See the [`parser`] module.

/// Link to external crate type
/// Works with [`std::collections::HashMap`].

/// Link with custom text
/// See [the parser][`parse`] for details.

/// Link to module item
/// See [`crate::utils::helper`].

/// Link to parent module item
/// See [`super::Parent`].
```

## Common Patterns

```rust
/// A configuration builder.
///
/// # Example
///
/// ```
/// use my_crate::Config;
///
/// let config = Config::builder()
///     .timeout(30)
///     .build()?;
/// ```
///
/// # Methods
///
/// - [`Config::builder`] - Create a new builder
/// - [`Config::default`] - Create with defaults
///
/// # Related Types
///
/// - [`ConfigBuilder`] - The builder returned by [`Config::builder`]
/// - [`ConfigError`] - Errors that can occur when building
pub struct Config { ... }

impl Config {
    /// Creates a new [`ConfigBuilder`].
    ///
    /// This is equivalent to [`ConfigBuilder::new`].
    pub fn builder() -> ConfigBuilder { ... }
}
```

## Linking to Trait Items

```rust
/// Implements [`Iterator`] for lazy evaluation.
///
/// The [`Iterator::next`] method advances the cursor.
/// 
/// For parallel iteration, see [`rayon::ParallelIterator`].
pub struct MyIterator { ... }

impl Iterator for MyIterator {
    /// Advances and returns the next value.
    ///
    /// See also [`Iterator::nth`] for skipping elements.
    fn next(&mut self) -> Option<Self::Item> { ... }
}
```

## Broken Link Detection

```bash
# Catch broken intra-doc links
RUSTDOCFLAGS="-D warnings" cargo doc

# Or in CI
cargo doc --no-deps 2>&1 | grep "warning: unresolved link"
```

```toml
# Cargo.toml - deny broken links
[lints.rustdoc]
broken_intra_doc_links = "deny"
```

## Module-Level Documentation

```rust
//! # Parser Module
//!
//! This module provides parsing utilities.
//!
//! ## Main Types
//!
//! - [`Parser`] - The main parser struct
//! - [`Token`] - Tokens produced by tokenization
//! - [`Ast`] - The abstract syntax tree
//!
//! ## Functions
//!
//! - [`parse`] - Parse a string
//! - [`parse_file`] - Parse a file
//!
//! ## Errors
//!
//! All functions return [`ParseError`] on failure.

pub struct Parser { ... }
pub enum Token { ... }
pub struct Ast { ... }
```

## See Also

- [doc-examples-section](./doc-examples-section.md) - Code examples in docs
- [err-doc-errors](./err-doc-errors.md) - Documenting errors
- [lint-deny-correctness](./lint-deny-correctness.md) - Lint settings
