# type-no-stringly

> Avoid stringly-typed APIs; use enums, newtypes, or validated types

## Why It Matters

Strings accept any value—typos, wrong formats, invalid data all compile fine. Enums, newtypes, and validated types catch errors at compile time or construction time, not runtime. They also provide better IDE support, documentation, and make invalid states unrepresentable.

## Bad

```rust
// Status as string - easy to get wrong
fn set_status(status: &str) {
    match status {
        "pending" => { ... }
        "active" => { ... }
        "completed" => { ... }
        _ => panic!("Unknown status"),  // Runtime error
    }
}

// Easy to misuse
set_status("pending");   // OK
set_status("Pending");   // Runtime error - wrong case
set_status("aktive");    // Runtime error - typo
set_status("done");      // Runtime error - wrong word

// Configuration as strings
fn configure(key: &str, value: &str) {
    // No type safety, no validation
}
```

## Good

```rust
// Status as enum - compile-time safety
enum Status {
    Pending,
    Active,
    Completed,
}

fn set_status(status: Status) {
    match status {
        Status::Pending => { ... }
        Status::Active => { ... }
        Status::Completed => { ... }
    }  // Exhaustive - compiler checks all cases
}

// Can only pass valid values
set_status(Status::Pending);  // OK
set_status(Status::Aktivev);  // Compile error - typo caught!

// Configuration with typed builder
struct Config {
    timeout: Duration,
    retries: u32,
    mode: Mode,
}

enum Mode { Fast, Safe, Balanced }
```

## Parsing at Boundaries

```rust
use std::str::FromStr;

#[derive(Debug, Clone, Copy)]
enum Priority {
    Low,
    Medium,
    High,
}

impl FromStr for Priority {
    type Err = ParseError;
    
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "low" => Ok(Priority::Low),
            "medium" | "med" => Ok(Priority::Medium),
            "high" => Ok(Priority::High),
            _ => Err(ParseError::UnknownPriority(s.to_string())),
        }
    }
}

// Parse once at boundary
fn handle_request(priority_str: &str) -> Result<(), Error> {
    let priority: Priority = priority_str.parse()?;
    // From here, priority is type-safe
    process(priority);
    Ok(())
}
```

## Validated Newtypes

```rust
// Instead of string for email
struct Email(String);

impl Email {
    fn new(s: &str) -> Result<Self, ValidationError> {
        if is_valid_email(s) {
            Ok(Email(s.to_string()))
        } else {
            Err(ValidationError::InvalidEmail)
        }
    }
}

// Instead of string for UUID
struct UserId(uuid::Uuid);

// Instead of string for paths
struct ConfigPath(PathBuf);
```

## With Serde

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum EventType {
    UserCreated,
    UserDeleted,
    UserUpdated,
}

// JSON: {"type": "user_created", ...}
// Automatically validated during deserialization
```

## See Also

- [anti-stringly-typed](./anti-stringly-typed.md) - Anti-pattern details
- [type-newtype-validated](./type-newtype-validated.md) - Validated newtypes
- [type-enum-states](./type-enum-states.md) - Enums for states
