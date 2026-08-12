# anti-unwrap-abuse

> Don't use `.unwrap()` in production code

## Why It Matters

`.unwrap()` panics on `None` or `Err`, crashing your program. In production, this means lost data, failed requests, and unhappy users. It also makes debugging harder since panic messages often lack context.

## Bad

```rust
// Crashes if file doesn't exist
let content = std::fs::read_to_string("config.toml").unwrap();

// Crashes on invalid input
let num: i32 = user_input.parse().unwrap();

// Crashes if key missing
let value = map.get("key").unwrap();

// Crashes if channel closed
let msg = receiver.recv().unwrap();
```

## Good

```rust
// Propagate with ?
fn load_config() -> Result<Config, Error> {
    let content = std::fs::read_to_string("config.toml")?;
    Ok(toml::from_str(&content)?)
}

// Provide default
let num: i32 = user_input.parse().unwrap_or(0);

// Handle missing key
let value = map.get("key").ok_or(Error::MissingKey)?;

// Or use if-let
if let Some(value) = map.get("key") {
    process(value);
}

// Channel with proper handling
match receiver.recv() {
    Ok(msg) => handle(msg),
    Err(_) => break,  // Channel closed
}
```

## When unwrap() Is Acceptable

```rust
// 1. Tests - panics are expected failures
#[test]
fn test_parse() {
    let result = parse("valid").unwrap();  // OK in tests
    assert_eq!(result, expected);
}

// 2. Const/static initialization (compile-time guaranteed)
static REGEX: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"^\d+$").unwrap()  // Known-valid pattern
});

// 3. After a check that guarantees success
if map.contains_key("key") {
    let value = map.get("key").unwrap();  // Just checked
}
// Better: use if-let or entry API instead

// 4. Truly impossible cases with proof comment
let last = vec.pop().unwrap();  
// OK only if you just checked !vec.is_empty()
// Better: use last() or pattern match
```

## Alternatives to unwrap()

```rust
// unwrap_or - provide default
let x = opt.unwrap_or(default);

// unwrap_or_default - use Default trait
let x = opt.unwrap_or_default();

// unwrap_or_else - compute default lazily
let x = opt.unwrap_or_else(|| expensive_default());

// ? operator - propagate errors
let x = opt.ok_or(Error::Missing)?;

// if let - handle Some/Ok case
if let Some(x) = opt {
    use_x(x);
}

// match - handle all cases
match opt {
    Some(x) => use_x(x),
    None => handle_none(),
}

// map - transform if present
let y = opt.map(|x| x + 1);

// and_then - chain fallible operations
let z = opt.and_then(|x| x.checked_add(1));
```

## expect() Is Slightly Better

```rust
// unwrap() - no context
let file = File::open(path).unwrap();
// Panics with: "called `Result::unwrap()` on an `Err` value: Os { code: 2, ... }"

// expect() - adds context
let file = File::open(path)
    .expect("config file should exist at startup");
// Panics with: "config file should exist at startup: Os { code: 2, ... }"

// But still use only for invariants, not error handling
```

## Clippy Lint

```rust
// Enable these lints to catch unwrap usage:
#![warn(clippy::unwrap_used)]
#![warn(clippy::expect_used)]  // Stricter

// Or per-function:
#[allow(clippy::unwrap_used)]
fn tests_only() { }
```

## See Also

- [err-question-mark](err-question-mark.md) - Use ? for propagation
- [err-result-over-panic](err-result-over-panic.md) - Return Result instead of panicking
- [anti-expect-lazy](anti-expect-lazy.md) - Don't use expect for recoverable errors
