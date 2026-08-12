# type-result-fallible

> Use `Result<T, E>` for operations that can fail

## Why It Matters

`Result<T, E>` makes failure explicit in the type system. Callers must acknowledge and handle potential errors—they can't accidentally ignore failures. The `?` operator makes error propagation ergonomic while maintaining explicit error handling.

## Bad

```rust
// Returning Option loses error context
fn read_config(path: &str) -> Option<Config> {
    let content = std::fs::read_to_string(path).ok()?;  // Why did it fail?
    toml::from_str(&content).ok()  // Parse error lost
}

// Panicking on errors
fn read_config(path: &str) -> Config {
    let content = std::fs::read_to_string(path).unwrap();  // Crashes
    toml::from_str(&content).unwrap()  // Crashes
}

// Sentinel values
fn divide(a: i32, b: i32) -> i32 {
    if b == 0 { return -1; }  // Magic value, easy to miss
    a / b
}
```

## Good

```rust
// Result with clear error type
fn read_config(path: &str) -> Result<Config, ConfigError> {
    let content = std::fs::read_to_string(path)
        .map_err(ConfigError::IoError)?;
    toml::from_str(&content)
        .map_err(ConfigError::ParseError)
}

fn divide(a: i32, b: i32) -> Result<i32, DivisionError> {
    if b == 0 {
        return Err(DivisionError::DivideByZero);
    }
    Ok(a / b)
}

// Caller must handle
match divide(10, 0) {
    Ok(result) => println!("Result: {}", result),
    Err(e) => println!("Error: {}", e),
}
```

## The ? Operator

```rust
fn process_file(path: &str) -> Result<ProcessedData, Error> {
    let content = std::fs::read_to_string(path)?;  // Propagates Err
    let parsed: RawData = serde_json::from_str(&content)?;
    let validated = validate(parsed)?;
    let processed = transform(validated)?;
    Ok(processed)
}

// Equivalent to:
fn process_file(path: &str) -> Result<ProcessedData, Error> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => return Err(e.into()),
    };
    // ... etc
}
```

## Result Combinators

```rust
let result: Result<i32, Error> = Ok(42);

// map: transform success value
let doubled = result.map(|n| n * 2);  // Ok(84)

// map_err: transform error
let with_context = result.map_err(|e| format!("Failed: {}", e));

// and_then: chain fallible operations
let processed = result.and_then(|n| {
    if n > 0 { Ok(n * 2) } else { Err(Error::Negative) }
});

// unwrap_or: provide default on error
let value = result.unwrap_or(0);

// ok(): convert to Option, discarding error
let maybe_value: Option<i32> = result.ok();
```

## Defining Error Types

```rust
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ConfigError {
    #[error("failed to read file: {0}")]
    Io(#[from] std::io::Error),
    
    #[error("failed to parse config: {0}")]
    Parse(#[from] toml::de::Error),
    
    #[error("missing required field: {0}")]
    MissingField(String),
}

fn load_config(path: &str) -> Result<Config, ConfigError> {
    let content = std::fs::read_to_string(path)?;  // Io error
    let config: Config = toml::from_str(&content)?;  // Parse error
    if config.name.is_empty() {
        return Err(ConfigError::MissingField("name".into()));
    }
    Ok(config)
}
```

## See Also

- [err-thiserror-lib](./err-thiserror-lib.md) - Defining error types
- [err-question-mark](./err-question-mark.md) - Using ? operator
- [type-option-nullable](./type-option-nullable.md) - Option vs Result
