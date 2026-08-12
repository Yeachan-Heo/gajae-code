# api-must-use

> Mark types and functions with `#[must_use]` when ignoring results is likely a bug

## Why It Matters

Some return values should never be ignored—`Result`, locks, RAII guards, computed values that have no side effects. Without `#[must_use]`, silently discarding these values can introduce subtle bugs that are hard to detect. The attribute generates compiler warnings when the value is unused.

## Bad

```rust
// Result ignored - error silently dropped
fn send_email(to: &str, body: &str) -> Result<(), EmailError> { ... }

send_email("user@example.com", "Hello!");  // No warning if Result ignored!
// Email may have failed, but we don't know

// Computed value ignored - likely a bug
fn compute_checksum(data: &[u8]) -> u32 { ... }

let data = vec![1, 2, 3, 4];
compute_checksum(&data);  // Result discarded - pointless call
```

## Good

```rust
#[must_use = "this `Result` may be an `Err` that should be handled"]
fn send_email(to: &str, body: &str) -> Result<(), EmailError> { ... }

send_email("user@example.com", "Hello!");  
// Warning: unused `Result` that must be used

// Mark pure functions
#[must_use = "this returns a new value and does not modify the input"]
fn compute_checksum(data: &[u8]) -> u32 { ... }

compute_checksum(&data);
// Warning: unused return value of `compute_checksum` that must be used
```

## Apply to Types

```rust
// Mark the type itself when it should always be used
#[must_use = "futures do nothing unless polled"]
struct MyFuture<T> { ... }

// Mark RAII guards
#[must_use = "if unused, the lock will be immediately released"]
struct MutexGuard<'a, T> { ... }

// Mark results/errors
#[must_use = "errors should be handled"]
enum AppError { ... }
```

## Standard Library Examples

```rust
// Result and Option are #[must_use]
let v: Vec<i32> = vec![1, 2, 3];
v.first();  // Warning: unused Option

// Iterator adapters are #[must_use]
v.iter().map(|x| x * 2);  // Warning: iterators are lazy

// String methods that return new values
let s = "hello";
s.to_uppercase();  // Warning: unused String
```

## When to Apply

```rust
// ✅ Pure functions (no side effects)
#[must_use]
fn add(a: i32, b: i32) -> i32 { a + b }

// ✅ Builder methods returning Self
#[must_use = "builder methods return a new builder"]
fn with_timeout(self, t: Duration) -> Self { ... }

// ✅ Fallible operations
#[must_use]
fn try_parse(s: &str) -> Result<Data, ParseError> { ... }

// ✅ Iterators and futures (lazy)
#[must_use = "iterators are lazy and do nothing unless consumed"]
struct Map<I, F> { ... }

// ❌ Side-effecting functions where result is optional
fn log(msg: &str) -> Result<(), io::Error> { ... }  // Might be ok to ignore

// ❌ Methods with useful side effects
fn vec.push(item);  // Mutates vec, no return to use
```

## Custom Messages

```rust
#[must_use = "creating a guard does nothing without assignment"]
struct ScopeGuard { ... }

#[must_use = "this returns the old value"]
fn replace(&mut self, new: T) -> T { ... }

#[must_use = "use `.await` to execute the future"]
async fn fetch() -> Data { ... }
```

## Clippy Lints

```toml
[lints.clippy]
must_use_candidate = "warn"      # Suggests where to add #[must_use]
unused_must_use = "deny"          # Built-in, treat warnings as errors
double_must_use = "warn"          # Redundant #[must_use]
```

## See Also

- [api-builder-must-use](./api-builder-must-use.md) - Builder pattern must_use
- [err-result-over-panic](./err-result-over-panic.md) - Result types require handling
- [lint-deny-correctness](./lint-deny-correctness.md) - Enabling useful lints
