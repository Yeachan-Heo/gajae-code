# err-doc-errors

> Document error conditions with `# Errors` section in doc comments

## Why It Matters

Users of your API need to know what can go wrong and why. The `# Errors` documentation section is the standard Rust convention for describing when a function returns `Err`. Good error documentation helps callers handle errors appropriately and understand the contract of your API.

## Bad

```rust
/// Loads a configuration from the specified path.
pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    // No documentation of error conditions
    // Caller must read source code to understand what can fail
}

/// Parses and validates the input string.
/// 
/// Returns the parsed value.  // What about errors?
pub fn parse_input(input: &str) -> Result<Value, ParseError> {
    // ...
}
```

## Good

```rust
/// Loads a configuration from the specified path.
///
/// # Errors
///
/// Returns an error if:
/// - The file at `path` does not exist or cannot be read
/// - The file contents are not valid TOML
/// - Required configuration keys are missing
/// - Configuration values are out of valid ranges
///
/// # Examples
///
/// ```
/// # use mylib::{load_config, ConfigError};
/// # fn main() -> Result<(), ConfigError> {
/// let config = load_config("app.toml")?;
/// # Ok(())
/// # }
/// ```
pub fn load_config(path: &Path) -> Result<Config, ConfigError> {
    // ...
}

/// Parses and validates the input string as a positive integer.
///
/// # Errors
///
/// Returns [`ParseError::Empty`] if the input is empty.
/// Returns [`ParseError::InvalidFormat`] if the input contains non-digit characters.
/// Returns [`ParseError::Overflow`] if the value exceeds `i64::MAX`.
/// Returns [`ParseError::NotPositive`] if the value is zero or negative.
pub fn parse_positive_int(input: &str) -> Result<i64, ParseError> {
    // ...
}
```

## Linking to Error Variants

```rust
/// Attempts to connect to the database.
///
/// # Errors
///
/// This function will return an error if:
///
/// - [`DbError::ConnectionFailed`] - The database server is unreachable
/// - [`DbError::AuthenticationFailed`] - Invalid credentials
/// - [`DbError::Timeout`] - Connection attempt exceeded timeout
/// - [`DbError::TlsError`] - TLS handshake failed
///
/// See [`DbError`] for more details on each variant.
pub fn connect(config: &DbConfig) -> Result<Connection, DbError> {
    // ...
}
```

## Panic vs Error Documentation

```rust
/// Divides two numbers.
///
/// # Errors
///
/// Returns [`MathError::DivisionByZero`] if `divisor` is zero.
///
/// # Panics
///
/// Panics if called from a non-main thread (debug builds only).
pub fn divide(dividend: i64, divisor: i64) -> Result<i64, MathError> {
    // ...
}
```

## Error Section Format Options

```rust
// Style 1: Bullet list (good for multiple conditions)
/// # Errors
///
/// Returns an error if:
/// - The file does not exist
/// - The file cannot be read
/// - The content is invalid UTF-8

// Style 2: Returns statements (good for mapping to variants)
/// # Errors
///
/// Returns [`Error::NotFound`] if the item doesn't exist.
/// Returns [`Error::PermissionDenied`] if access is forbidden.

// Style 3: Prose (good for complex conditions)
/// # Errors
///
/// This function returns an error when the input fails validation.
/// Validation includes checking that all required fields are present,
/// that numeric fields are within allowed ranges, and that string
/// fields match their expected formats.
```

## Clippy Lint

```toml
# Cargo.toml - require error documentation
[lints.clippy]
missing_errors_doc = "warn"
```

```rust
// This will warn without # Errors section
pub fn might_fail() -> Result<(), Error> { Ok(()) }
```

## See Also

- [doc-examples-section](./doc-examples-section.md) - Examples in documentation
- [err-thiserror-lib](./err-thiserror-lib.md) - Defining error types
- [api-must-use](./api-must-use.md) - Marking Results as must_use
