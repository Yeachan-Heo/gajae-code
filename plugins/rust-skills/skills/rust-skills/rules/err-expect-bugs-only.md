# err-expect-bugs-only

> Use `expect()` only for invariants that indicate bugs, not user errors

## Why It Matters

`expect()` is better than `unwrap()` because it provides context, but it still panics. Reserve it for situations where failure indicates a bug in your code—a violated invariant, not a user error or external failure. The message should explain why the invariant should hold, helping future developers understand and fix the bug.

## Bad

```rust
// User input can legitimately fail - don't expect
fn parse_user_input(input: &str) -> Config {
    serde_json::from_str(input)
        .expect("Invalid JSON")  // User error, not a bug!
}

// Network can fail - don't expect
fn fetch_data(url: &str) -> Data {
    reqwest::get(url)
        .expect("Network request failed")  // External failure!
        .json()
        .expect("Invalid response")
}

// File might not exist - don't expect
fn load_config() -> Config {
    let content = fs::read_to_string("config.json")
        .expect("Config file missing");  // Environment issue!
}
```

## Good

```rust
// Invariant: after insert, key exists
fn cache_and_get(&mut self, key: String, value: Value) -> &Value {
    self.cache.insert(key.clone(), value);
    self.cache.get(&key)
        .expect("BUG: key must exist immediately after insert")
}

// Invariant: regex is compile-time constant
fn create_parser() -> Regex {
    Regex::new(r"^\d{4}-\d{2}-\d{2}$")
        .expect("BUG: date regex is invalid - this is a compile-time constant")
}

// Invariant: already validated
fn process_validated(data: ValidatedData) -> Result<Output, ProcessError> {
    let value = data.required_field
        .expect("BUG: ValidatedData guarantees required_field is Some");
    // ...
}

// Invariant: type system guarantees
fn get_first<T>(vec: Vec<T>) -> T 
where 
    Vec<T>: NonEmpty,  // Hypothetical trait
{
    vec.into_iter().next()
        .expect("BUG: NonEmpty Vec cannot be empty")
}
```

## expect() Message Guidelines

Messages should:
1. Start with "BUG:" or similar to indicate it's an invariant
2. Explain WHY the invariant should hold
3. Help developers fix the issue

```rust
// ❌ Bad messages
.expect("failed")                    // No context
.expect("should not be None")        // Doesn't explain why
.expect("Invalid state")             // Vague

// ✅ Good messages
.expect("BUG: HashMap entry exists after insert")
.expect("BUG: validated input must parse - validation is broken")
.expect("BUG: static regex compilation failed - regex syntax error in source")
```

## Pattern: Validate Once, expect() After

```rust
struct ValidatedEmail(String);

impl ValidatedEmail {
    pub fn new(email: &str) -> Result<Self, EmailError> {
        // Validation happens here, returns Result
        if !is_valid_email(email) {
            return Err(EmailError::Invalid);
        }
        Ok(ValidatedEmail(email.to_string()))
    }
    
    pub fn domain(&self) -> &str {
        // After validation, expect() is fine
        self.0.split('@').nth(1)
            .expect("BUG: ValidatedEmail must contain @")
    }
}
```

## Alternatives When expect() Is Wrong

```rust
// Don't: expect on user data
let port: u16 = input.parse().expect("Invalid port");

// Do: Return Result
let port: u16 = input.parse().map_err(|_| ConfigError::InvalidPort)?;

// Do: Provide default
let port: u16 = input.parse().unwrap_or(8080);

// Do: Handle explicitly
let port: u16 = match input.parse() {
    Ok(p) => p,
    Err(_) => {
        log::warn!("Invalid port '{}', using default", input);
        8080
    }
};
```

## See Also

- [err-no-unwrap-prod](./err-no-unwrap-prod.md) - Avoiding unwrap in production
- [err-result-over-panic](./err-result-over-panic.md) - When to return Result
- [api-parse-dont-validate](./api-parse-dont-validate.md) - Type-driven validation
