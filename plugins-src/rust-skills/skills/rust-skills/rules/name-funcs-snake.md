# name-funcs-snake

> Use `snake_case` for functions, methods, variables, and modules

## Why It Matters

Rust uses `snake_case` for "value-level" names—functions, methods, variables, modules. This convention is enforced by the compiler and distinguishes runtime entities from types. Consistent naming makes code scannable and predictable.

## Bad

```rust
// CamelCase functions - compiler warns
fn calculateTotal() -> f64 { ... }  // warning: function `calculateTotal` should have a snake case name
fn getUserName() -> String { ... }  // warning

// Inconsistent naming
fn get_user() -> User { ... }
fn fetchOrder() -> Order { ... }  // Mixed conventions
```

## Good

```rust
// snake_case for functions
fn calculate_total() -> f64 { ... }
fn get_user_name() -> String { ... }
fn fetch_order() -> Order { ... }

// snake_case for methods
impl User {
    fn full_name(&self) -> String { ... }
    fn is_active(&self) -> bool { ... }
    fn set_email(&mut self, email: &str) { ... }
}

// snake_case for variables
let user_count = 42;
let max_connections = 100;
let is_valid = true;

// snake_case for modules
mod user_service;
mod http_client;
mod json_parser;
```

## Acronyms in snake_case

```rust
// Lowercase acronyms in snake_case
fn parse_json() -> Json { ... }   // Not parse_JSON
fn connect_tcp() -> TcpStream { ... }   // Not connect_TCP
fn generate_uuid() -> Uuid { ... }      // Not generate_UUID

let http_response = fetch();
let json_data = parse();
```

## Local Variables

```rust
fn process_data(input_data: &[u8]) -> Result<Output, Error> {
    let raw_bytes = input_data;
    let decoded_string = decode(raw_bytes)?;
    let parsed_value = parse(&decoded_string)?;
    let final_result = transform(parsed_value)?;
    
    Ok(final_result)
}
```

## See Also

- [name-types-camel](./name-types-camel.md) - Type naming
- [name-consts-screaming](./name-consts-screaming.md) - Constant naming
- [name-lifetime-short](./name-lifetime-short.md) - Lifetime naming
