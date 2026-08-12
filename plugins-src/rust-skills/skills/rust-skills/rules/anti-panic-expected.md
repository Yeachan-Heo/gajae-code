# anti-panic-expected

> Don't panic on expected or recoverable errors

## Why It Matters

Panics crash the program. They're for unrecoverable situations—bugs, corrupted state, invariant violations. Using panic for expected conditions (network failures, file not found, invalid input) makes programs fragile and forces callers to catch panics or die.

Use `Result` for recoverable errors.

## Bad

```rust
// Network failures are expected
fn fetch_data(url: &str) -> Data {
    let response = reqwest::blocking::get(url)
        .expect("network error");  // Crashes on timeout
    response.json().expect("invalid json")  // Crashes on bad response
}

// User input is often invalid
fn parse_config(input: &str) -> Config {
    toml::from_str(input).expect("invalid config")  // Crashes on typo
}

// Files may not exist
fn load_settings() -> Settings {
    let content = fs::read_to_string("settings.json")
        .expect("settings not found");  // Crashes if missing
    serde_json::from_str(&content).expect("invalid settings")
}

// Custom panic for validation
fn process_age(age: i32) {
    if age < 0 {
        panic!("age cannot be negative");  // Should return error
    }
}
```

## Good

```rust
// Return errors for expected failures
fn fetch_data(url: &str) -> Result<Data, FetchError> {
    let response = reqwest::blocking::get(url)
        .context("failed to connect")?;
    let data = response.json()
        .context("failed to parse response")?;
    Ok(data)
}

// Validate and return Result
fn parse_config(input: &str) -> Result<Config, ConfigError> {
    toml::from_str(input).map_err(ConfigError::Parse)
}

// Handle missing files gracefully
fn load_settings() -> Result<Settings, SettingsError> {
    let content = fs::read_to_string("settings.json")?;
    let settings = serde_json::from_str(&content)?;
    Ok(settings)
}

// Return error for validation failure
fn process_age(age: i32) -> Result<(), ValidationError> {
    if age < 0 {
        return Err(ValidationError::NegativeAge);
    }
    Ok(())
}
```

## When to Panic

Panic IS appropriate for:

```rust
// Bug detection - invariant violated
fn get_unchecked(&self, index: usize) -> &T {
    assert!(index < self.len(), "index out of bounds - this is a bug");
    unsafe { self.data.get_unchecked(index) }
}

// Unrecoverable state
fn init() {
    if !CAN_PROCEED {
        panic!("system requirements not met");
    }
}

// Tests
#[test]
fn test_fails() {
    panic!("expected panic in test");
}
```

## Decision Guide

| Condition | Action |
|-----------|--------|
| Invalid user input | Return `Err` |
| Network failure | Return `Err` |
| File not found | Return `Err` |
| Malformed data | Return `Err` |
| Bug/impossible state | `panic!` or `unreachable!` |
| Failed assertion in test | `panic!` |
| Unrecoverable init failure | `panic!` |

## Anti-pattern: panic! for Control Flow

```rust
// BAD: Using panic for control flow
fn find_or_die(items: &[Item], id: u64) -> &Item {
    items.iter()
        .find(|i| i.id == id)
        .unwrap_or_else(|| panic!("item {} not found", id))
}

// GOOD: Return Option or Result
fn find(items: &[Item], id: u64) -> Option<&Item> {
    items.iter().find(|i| i.id == id)
}
```

## See Also

- [err-result-over-panic](./err-result-over-panic.md) - Use Result
- [anti-unwrap-abuse](./anti-unwrap-abuse.md) - Unwrap anti-pattern
- [err-expect-bugs-only](./err-expect-bugs-only.md) - When to expect
