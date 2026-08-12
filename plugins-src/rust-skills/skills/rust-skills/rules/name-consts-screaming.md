# name-consts-screaming

> Use `SCREAMING_SNAKE_CASE` for constants and statics

## Why It Matters

Constants and statics are special—they're known at compile time and have program-wide lifetime. `SCREAMING_SNAKE_CASE` makes them visually distinct from runtime variables. This convention is enforced by the compiler and universally expected.

## Bad

```rust
// lowercase/camelCase constants - compiler warns
const maxConnections: u32 = 100;  // warning
const default_timeout: u64 = 30;  // warning
static globalCounter: AtomicU64 = AtomicU64::new(0);  // warning
```

## Good

```rust
// SCREAMING_SNAKE_CASE for constants
const MAX_CONNECTIONS: u32 = 100;
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
const BUFFER_SIZE: usize = 4096;

// SCREAMING_SNAKE_CASE for statics
static GLOBAL_COUNTER: AtomicU64 = AtomicU64::new(0);
static CONFIG: OnceLock<Config> = OnceLock::new();

// Type-level constants in impl blocks
impl Buffer {
    const INITIAL_CAPACITY: usize = 1024;
    const MAX_CAPACITY: usize = 1024 * 1024;
}
```

## Associated Constants

```rust
trait Limit {
    const MAX: usize;
    const MIN: usize;
}

impl Limit for SmallBuffer {
    const MAX: usize = 256;
    const MIN: usize = 16;
}

// Generic associated constants
struct Container<T> {
    data: Vec<T>,
}

impl<T> Container<T> {
    const EMPTY: Self = Self { data: Vec::new() };
}
```

## Environment and Config

```rust
// Environment variable names
const ENV_DATABASE_URL: &str = "DATABASE_URL";
const ENV_LOG_LEVEL: &str = "LOG_LEVEL";

// Configuration keys
const CONFIG_TIMEOUT_SECONDS: &str = "timeout_seconds";
const CONFIG_MAX_RETRIES: &str = "max_retries";
```

## Lazy Static / OnceLock

```rust
use std::sync::OnceLock;

// Global configuration
static CONFIG: OnceLock<AppConfig> = OnceLock::new();

// Compiled regex
static EMAIL_REGEX: OnceLock<Regex> = OnceLock::new();

fn get_email_regex() -> &'static Regex {
    EMAIL_REGEX.get_or_init(|| {
        Regex::new(r"^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$").unwrap()
    })
}
```

## See Also

- [name-funcs-snake](./name-funcs-snake.md) - Function/variable naming
- [name-types-camel](./name-types-camel.md) - Type naming
- [type-newtype-ids](./type-newtype-ids.md) - Type-safe constants
