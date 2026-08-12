# anti-stringly-typed

> Don't use strings where enums or newtypes would provide type safety

## Why It Matters

Strings are the most primitive way to represent data—they accept any value, provide no validation, and offer no IDE support. When you have a fixed set of valid values or a semantic type, use enums or newtypes. The compiler catches mistakes at compile time instead of runtime.

## Bad

```rust
fn process_order(status: &str, priority: &str) {
    // What are valid statuses? "pending"? "Pending"? "PENDING"?
    // What are valid priorities? "high"? "1"? "urgent"?
    match status {
        "pending" => { ... }
        "completed" => { ... }
        _ => panic!("unknown status"),  // Runtime error
    }
}

struct User {
    email: String,    // Any string, even "not an email"
    phone: String,    // Any string, even "hello"
    user_id: String,  // Could be confused with other string IDs
}

// Easy to make mistakes
process_order("complete", "high");  // Typo: "complete" vs "completed"
process_order("high", "pending");   // Swapped arguments - compiles!
```

## Good

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum OrderStatus {
    Pending,
    Processing,
    Completed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Priority {
    Low,
    Medium,
    High,
    Critical,
}

fn process_order(status: OrderStatus, priority: Priority) {
    match status {
        OrderStatus::Pending => { ... }
        OrderStatus::Processing => { ... }
        OrderStatus::Completed => { ... }
        OrderStatus::Cancelled => { ... }
    }  // Exhaustive - compiler checks all cases
}

// Validated newtypes
struct Email(String);
struct PhoneNumber(String);
struct UserId(u64);

impl Email {
    pub fn new(s: &str) -> Result<Self, ValidationError> {
        if is_valid_email(s) {
            Ok(Email(s.to_string()))
        } else {
            Err(ValidationError::InvalidEmail)
        }
    }
}

struct User {
    email: Email,       // Must be valid email
    phone: PhoneNumber, // Must be valid phone
    user_id: UserId,    // Can't confuse with other IDs
}

// Compile errors catch mistakes
process_order(OrderStatus::Completed, Priority::High);  // Clear and correct
process_order(Priority::High, OrderStatus::Pending);    // Compile error!
```

## Parsing Strings to Types

```rust
use std::str::FromStr;

#[derive(Debug, Clone, Copy)]
enum OrderStatus {
    Pending,
    Processing,
    Completed,
    Cancelled,
}

impl FromStr for OrderStatus {
    type Err = ParseError;
    
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s.to_lowercase().as_str() {
            "pending" => Ok(OrderStatus::Pending),
            "processing" => Ok(OrderStatus::Processing),
            "completed" => Ok(OrderStatus::Completed),
            "cancelled" | "canceled" => Ok(OrderStatus::Cancelled),
            _ => Err(ParseError::UnknownStatus(s.to_string())),
        }
    }
}

// Parse at boundary, use types internally
fn handle_request(status_str: &str) -> Result<(), Error> {
    let status: OrderStatus = status_str.parse()?;  // Validate once
    process_order(status);  // Type-safe from here
    Ok(())
}
```

## With Serde

```rust
use serde::{Serialize, Deserialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Status {
    Pending,
    InProgress,
    Completed,
}

// JSON: {"status": "in_progress"}
// Deserialization validates automatically
```

## Error Messages

```rust
#[derive(Debug, Clone, Copy)]
enum Color {
    Red,
    Green,
    Blue,
}

impl std::fmt::Display for Color {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Color::Red => write!(f, "red"),
            Color::Green => write!(f, "green"),
            Color::Blue => write!(f, "blue"),
        }
    }
}

// Type-safe and displayable
println!("Selected color: {}", Color::Red);
```

## See Also

- [api-newtype-safety](./api-newtype-safety.md) - Newtype pattern
- [api-parse-dont-validate](./api-parse-dont-validate.md) - Parse at boundaries
- [type-newtype-ids](./type-newtype-ids.md) - Type-safe IDs
