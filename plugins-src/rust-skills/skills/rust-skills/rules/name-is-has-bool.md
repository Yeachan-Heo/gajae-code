# name-is-has-bool

> Use `is_`, `has_`, `can_`, `should_` prefixes for boolean-returning methods

## Why It Matters

Boolean methods answer yes/no questions. Prefixes like `is_`, `has_`, `can_` make the question explicit, so code reads naturally: `if user.is_active()`, `if buffer.has_remaining()`. Without prefixes, boolean methods are ambiguous and require reading documentation.

## Bad

```rust
impl User {
    // Unclear: does this check or set?
    fn active(&self) -> bool { ... }
    
    // Unclear: does this delete or check?
    fn deleted(&self) -> bool { ... }
    
    // Unclear return type
    fn admin(&self) -> bool { ... }
}

// Reading code is confusing
if user.active() { ... }  // Is this checking or activating?
```

## Good

```rust
impl User {
    // Clear: answers "is the user active?"
    fn is_active(&self) -> bool { ... }
    
    // Clear: answers "is the user deleted?"
    fn is_deleted(&self) -> bool { ... }
    
    // Clear: answers "is the user an admin?"
    fn is_admin(&self) -> bool { ... }
    
    // Clear: answers "does the user have permission X?"
    fn has_permission(&self, perm: Permission) -> bool { ... }
    
    // Clear: answers "can the user edit?"
    fn can_edit(&self) -> bool { ... }
}

// Reads naturally
if user.is_active() && user.has_permission(Permission::Write) {
    // ...
}
```

## Common Prefixes

| Prefix | Use For | Example |
|--------|---------|---------|
| `is_` | State/property check | `is_empty()`, `is_valid()`, `is_some()` |
| `has_` | Possession/containment | `has_key()`, `has_children()`, `has_remaining()` |
| `can_` | Capability/permission | `can_read()`, `can_write()`, `can_execute()` |
| `should_` | Recommendation/policy | `should_retry()`, `should_cache()` |
| `needs_` | Requirement | `needs_update()`, `needs_auth()` |
| `will_` | Future action | `will_block()`, `will_overflow()` |

## Standard Library Examples

```rust
// is_ prefix
vec.is_empty()
option.is_some()
option.is_none()
result.is_ok()
result.is_err()
char.is_alphabetic()
str.is_ascii()
path.is_file()
path.is_dir()

// has_ prefix (less common in std)
iterator.has_next()  // conceptual

// Checking methods
str.contains("foo")      // Not is_ because takes argument
str.starts_with("bar")   // Descriptive verb phrase
str.ends_with("baz")
```

## Negation

```rust
// Prefer positive form with caller negation
if !user.is_active() { ... }

// Rather than negative method
if user.is_inactive() { ... }  // Avoid double negatives: !is_inactive()

// Exception: when negative is the common case
fn is_empty(&self) -> bool { ... }     // Checking for empty is common
fn is_not_empty(&self) -> bool { ... } // Rarely needed, use !is_empty()
```

## Boolean Fields

```rust
struct Config {
    // Field names can omit prefix
    enabled: bool,
    verbose: bool,
    debug: bool,
}

impl Config {
    // But methods should have prefix
    fn is_enabled(&self) -> bool {
        self.enabled
    }
    
    fn is_verbose(&self) -> bool {
        self.verbose
    }
}
```

## See Also

- [name-no-get-prefix](./name-no-get-prefix.md) - Getter naming
- [name-funcs-snake](./name-funcs-snake.md) - Function naming
- [api-must-use](./api-must-use.md) - Boolean functions should be checked
