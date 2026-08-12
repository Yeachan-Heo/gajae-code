# type-newtype-validated

> Use newtypes to enforce validation at construction time

## Why It Matters

A validated newtype guarantees its inner value is always valid. Once you have an `Email`, you know it passed validation—no re-checking needed. This "parse, don't validate" pattern catches errors at boundaries and makes invalid states unrepresentable.

## Bad

```rust
// Validation scattered throughout code
fn send_email(to: &str, body: &str) -> Result<(), Error> {
    if !is_valid_email(to) {  // Must check every time
        return Err(Error::InvalidEmail);
    }
    // ...
}

fn add_recipient(list: &mut Vec<String>, email: &str) -> Result<(), Error> {
    if !is_valid_email(email) {  // Check again
        return Err(Error::InvalidEmail);
    }
    list.push(email.to_string());
    Ok(())
}
```

## Good

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Email(String);

impl Email {
    pub fn new(s: &str) -> Result<Self, EmailError> {
        if is_valid_email(s) {
            Ok(Email(s.to_string()))
        } else {
            Err(EmailError::Invalid(s.to_string()))
        }
    }
    
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

// No validation needed - Email is always valid
fn send_email(to: &Email, body: &str) -> Result<(), Error> {
    // to is guaranteed valid
    send_to_address(to.as_str(), body)
}

fn add_recipient(list: &mut Vec<Email>, email: Email) {
    // email is guaranteed valid
    list.push(email);
}
```

## Common Validated Types

```rust
// URLs
pub struct Url(url::Url);

impl Url {
    pub fn parse(s: &str) -> Result<Self, UrlError> {
        url::Url::parse(s)
            .map(Url)
            .map_err(UrlError::from)
    }
}

// Non-empty strings
pub struct NonEmptyString(String);

impl NonEmptyString {
    pub fn new(s: String) -> Option<Self> {
        if s.is_empty() {
            None
        } else {
            Some(NonEmptyString(s))
        }
    }
}

// Positive numbers
pub struct PositiveI32(i32);

impl PositiveI32 {
    pub fn new(n: i32) -> Option<Self> {
        if n > 0 {
            Some(PositiveI32(n))
        } else {
            None
        }
    }
    
    pub fn get(&self) -> i32 {
        self.0
    }
}

// Bounded ranges
pub struct Percentage(f64);

impl Percentage {
    pub fn new(value: f64) -> Result<Self, RangeError> {
        if (0.0..=100.0).contains(&value) {
            Ok(Percentage(value))
        } else {
            Err(RangeError::OutOfBounds)
        }
    }
}
```

## With Serde

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct Email(String);

impl<'de> Deserialize<'de> for Email {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        Email::new(&s).map_err(serde::de::Error::custom)
    }
}

// JSON deserialization automatically validates
let email: Email = serde_json::from_str(r#""user@example.com""#)?;
```

## Compile-Time Validation

```rust
// For values known at compile time
macro_rules! email {
    ($s:literal) => {{
        const _: () = assert!(is_valid_email_const($s));
        Email::new_unchecked($s)
    }};
}

let admin = email!("admin@example.com");  // Validated at compile time
```

## See Also

- [api-parse-dont-validate](./api-parse-dont-validate.md) - Parse at boundaries
- [api-newtype-safety](./api-newtype-safety.md) - Type-safe distinctions
- [type-newtype-ids](./type-newtype-ids.md) - ID newtypes
- [conv-fromstr-parsing](./conv-fromstr-parsing.md) - FromStr for validated parsing
- [serde-try-from-validate](./serde-try-from-validate.md) - Validate during deserialization
