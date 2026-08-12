# anti-format-hot-path

> Don't use format! in hot paths

## Why It Matters

`format!()` allocates a new `String` every call. In hot paths (loops, frequently called functions), this creates allocation churn that impacts performance. Pre-allocate, reuse buffers, or use `write!()` to an existing buffer.

## Bad

```rust
// format! in loop - allocates every iteration
fn log_events(events: &[Event]) {
    for event in events {
        let message = format!("[{}] {}: {}", event.level, event.source, event.message);
        logger.log(&message);
    }
}

// format! for building parts
fn build_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("{}{}", base, path);
    for (key, value) in params {
        url = format!("{}{}={}&", url, key, value);  // New allocation each time
    }
    url
}

// format! for simple concatenation
fn greet(name: &str) -> String {
    format!("Hello, {}!", name)  // Fine for one-off, bad if called 1M times
}
```

## Good

```rust
use std::fmt::Write;

// Reuse buffer across iterations
fn log_events(events: &[Event]) {
    let mut buffer = String::with_capacity(256);
    for event in events {
        buffer.clear();
        write!(buffer, "[{}] {}: {}", event.level, event.source, event.message).unwrap();
        logger.log(&buffer);
    }
}

// Build incrementally in single buffer
fn build_url(base: &str, path: &str, params: &[(&str, &str)]) -> String {
    let mut url = String::with_capacity(base.len() + path.len() + params.len() * 20);
    url.push_str(base);
    url.push_str(path);
    for (key, value) in params {
        write!(url, "{}={}&", key, value).unwrap();
    }
    url
}

// For truly hot paths, avoid allocation entirely
fn greet_to_buf(name: &str, buffer: &mut String) {
    buffer.clear();
    buffer.push_str("Hello, ");
    buffer.push_str(name);
    buffer.push('!');
}
```

## Comparison

| Approach | Allocations | Performance |
|----------|-------------|-------------|
| `format!()` in loop | N | Slow |
| `write!()` to reused buffer | 1 | Fast |
| `push_str()` + `push()` | 1 | Fastest |
| Pre-sized `String::with_capacity()` | 1 (no realloc) | Fast |

## When format! Is Fine

```rust
// One-time initialization
let config_path = format!("{}/config.toml", home_dir);

// Error messages (not hot path)
return Err(format!("invalid input: {}", input));

// Debug output
println!("Debug: {:?}", value);
```

## Pattern: Formatter Buffer Pool

```rust
use std::cell::RefCell;
use std::fmt::Write; // for write! into the String buffer

thread_local! {
    static BUFFER: RefCell<String> = RefCell::new(String::with_capacity(256));
}

fn format_event(event: &Event) -> String {
    BUFFER.with(|buf| {
        let mut buf = buf.borrow_mut();
        buf.clear();
        write!(buf, "[{}] {}", event.level, event.message).unwrap();
        buf.clone()  // Still one allocation per call, but no parsing
    })
}
```

## Pattern: Display Implementation

```rust
use std::fmt::Write; // for the caller's write! into a String

struct Event {
    level: Level,
    message: String,
}

impl std::fmt::Display for Event {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{}] {}", self.level, self.message)
    }
}

// Caller controls allocation
let mut buf = String::new();
write!(buf, "{}", event)?;
```

## Clippy Lint

```toml
[lints.clippy]
format_in_format_args = "warn"
```

## See Also

- [mem-avoid-format](./mem-avoid-format.md) - Avoiding format
- [mem-write-over-format](./mem-write-over-format.md) - Using write!
- [mem-reuse-collections](./mem-reuse-collections.md) - Buffer reuse
