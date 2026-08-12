# opt-inline-never-cold

> Use `#[inline(never)]` and `#[cold]` for error paths and rarely-executed code

## Why It Matters

Inlining error handling code into hot paths wastes instruction cache space and can prevent other optimizations. `#[inline(never)]` keeps cold code out of the hot path. `#[cold]` tells the compiler this branch is unlikely, enabling better branch prediction hints and code layout.

## Bad

```rust
fn process_data(data: &[u8]) -> Result<Output, Error> {
    if data.is_empty() {
        // Error path inlined into hot function
        return Err(Error::Empty {
            context: format!("Expected data, got empty slice"),
            suggestions: vec!["Check input", "Validate before calling"],
        });
    }
    
    // Hot path - now polluted with error construction code
    do_processing(data)
}
```

## Good

```rust
fn process_data(data: &[u8]) -> Result<Output, Error> {
    if data.is_empty() {
        return Err(empty_data_error());  // Cold path stays small
    }
    
    do_processing(data)
}

#[cold]
#[inline(never)]
fn empty_data_error() -> Error {
    Error::Empty {
        context: format!("Expected data, got empty slice"),
        suggestions: vec!["Check input", "Validate before calling"],
    }
}
```

## #[cold] for Unlikely Branches

```rust
fn parse_value(input: &str) -> Result<i32, ParseError> {
    match input.parse() {
        Ok(n) => Ok(n),
        Err(e) => cold_parse_error(input, e),
    }
}

#[cold]
fn cold_parse_error(input: &str, e: std::num::ParseIntError) -> Result<i32, ParseError> {
    Err(ParseError {
        input: input.to_string(),
        source: e,
    })
}
```

## Panic Paths

```rust
fn get_index(&self, idx: usize) -> &T {
    if idx >= self.len {
        cold_out_of_bounds(idx, self.len);
    }
    unsafe { self.ptr.add(idx).as_ref().unwrap() }
}

#[cold]
#[inline(never)]
fn cold_out_of_bounds(idx: usize, len: usize) -> ! {
    panic!("index {} out of bounds for length {}", idx, len);
}
```

## Error Construction Functions

```rust
// Keep error construction out of hot path
impl MyError {
    #[cold]
    pub fn io_error(source: std::io::Error, path: &Path) -> Self {
        MyError::Io {
            source,
            path: path.to_path_buf(),
            context: get_context(),
        }
    }
    
    #[cold]
    pub fn validation_error(msg: &str, field: &str) -> Self {
        MyError::Validation {
            message: msg.to_string(),
            field: field.to_string(),
        }
    }
}

fn read_config(path: &Path) -> Result<Config, MyError> {
    std::fs::read_to_string(path)
        .map_err(|e| MyError::io_error(e, path))?
        .parse()
        .map_err(|e| MyError::parse_error(e))
}
```

## likely/unlikely Hints

```rust
// Nightly: std::hint likely/unlikely branch hints (still unstable as of Rust 1.96)
// (std::hint::cold_path() is stable since 1.95 for marking the rare branch)
#![feature(likely_unlikely)]
use std::hint::{likely, unlikely};

fn process(data: Option<&Data>) -> Result<Output, Error> {
    if unlikely(data.is_none()) {
        return cold_none_error();
    }
    
    let data = data.unwrap();
    
    if likely(data.is_valid()) {
        fast_process(data)
    } else {
        slow_validate_and_process(data)
    }
}

// Stable alternative: structure code so hot path is "fall through"
fn process(data: Option<&Data>) -> Result<Output, Error> {
    let data = match data {
        Some(d) => d,
        None => return cold_none_error(),  // Early return = unlikely hint
    };
    
    // Compiler assumes code after early returns is "hot"
    fast_process(data)
}
```

## Pattern: Extract Cold Code

```rust
// Before: cold code inline
fn hot_function(x: i32) -> i32 {
    if x < 0 {
        log::error!("Negative value: {}", x);
        eprintln!("Debug info: {:?}", std::backtrace::Backtrace::capture());
        return 0;
    }
    x * 2
}

// After: cold code extracted
fn hot_function(x: i32) -> i32 {
    if x < 0 {
        return handle_negative(x);
    }
    x * 2
}

#[cold]
#[inline(never)]
fn handle_negative(x: i32) -> i32 {
    log::error!("Negative value: {}", x);
    eprintln!("Debug info: {:?}", std::backtrace::Backtrace::capture());
    0
}
```

## See Also

- [opt-inline-small](./opt-inline-small.md) - Inlining for hot code
- [opt-inline-always-rare](./opt-inline-always-rare.md) - Forced inlining
- [err-result-over-panic](./err-result-over-panic.md) - Error handling patterns
