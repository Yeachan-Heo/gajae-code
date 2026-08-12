# type-option-nullable

> Use `Option<T>` for values that might not exist

## Why It Matters

`Option<T>` explicitly represents "value or nothing" in the type system. Unlike null pointers or sentinel values, you can't accidentally use a missing value—the compiler forces you to handle the `None` case. This eliminates null pointer exceptions at compile time.

## Bad

```rust
// Sentinel values - easy to forget to check
fn find_user(id: u64) -> User {
    // Returns "empty" user if not found - caller might not check
    users.get(&id).cloned().unwrap_or(User::empty())
}

// Nullable-style with raw pointers
fn find_user(id: u64) -> *const User {
    // Null if not found - unsafe, no compiler help
}

// Error-prone usage
let user = find_user(42);
println!("{}", user.name);  // Might be empty user - silent bug
```

## Good

```rust
// Option makes absence explicit
fn find_user(id: u64) -> Option<User> {
    users.get(&id).cloned()
}

// Must handle the None case
let user = find_user(42);
match user {
    Some(u) => println!("{}", u.name),
    None => println!("User not found"),
}

// Or use combinators
let name = find_user(42)
    .map(|u| u.name)
    .unwrap_or_else(|| "Unknown".to_string());
```

## Common Option Patterns

```rust
// if let for single case
if let Some(user) = find_user(id) {
    process(user);
}

// Chaining with map
let upper_name = find_user(id)
    .map(|u| u.name)
    .map(|n| n.to_uppercase());

// Providing defaults
let user = find_user(id).unwrap_or_default();
let user = find_user(id).unwrap_or_else(|| User::guest());

// ? operator for propagation
fn get_user_email(id: u64) -> Option<String> {
    let user = find_user(id)?;
    Some(user.email)
}

// and_then for chained optionals
fn get_user_country(id: u64) -> Option<String> {
    find_user(id)
        .and_then(|u| u.address)
        .and_then(|a| a.country)
}
```

## Struct Fields

```rust
struct User {
    name: String,
    email: String,
    phone: Option<String>,        // Optional field
    avatar_url: Option<Url>,      // Optional field
}

impl User {
    fn display_phone(&self) -> &str {
        self.phone.as_deref().unwrap_or("Not provided")
    }
}
```

## Option vs Result

```rust
// Option: value might not exist (no error context)
fn find(key: &str) -> Option<Value> { ... }

// Result: operation might fail (with error context)
fn parse(input: &str) -> Result<Value, ParseError> { ... }

// Convert Option to Result
let value = find("key").ok_or(Error::NotFound)?;

// Convert Result to Option
let value = parse("input").ok();  // Discards error
```

## Option References

```rust
// Option<&T> for optional borrows
fn get(&self, key: &str) -> Option<&Value> {
    self.map.get(key)
}

// as_ref() to borrow Option contents
let opt: Option<String> = Some("hello".to_string());
let opt_ref: Option<&String> = opt.as_ref();
let opt_str: Option<&str> = opt.as_deref();

// as_mut() for mutable borrow
let mut opt = Some(vec![1, 2, 3]);
if let Some(v) = opt.as_mut() {
    v.push(4);
}
```

## See Also

- [type-result-fallible](./type-result-fallible.md) - Result for errors
- [type-enum-states](./type-enum-states.md) - Enums for states
- [err-no-unwrap-prod](./err-no-unwrap-prod.md) - Handling Option safely
