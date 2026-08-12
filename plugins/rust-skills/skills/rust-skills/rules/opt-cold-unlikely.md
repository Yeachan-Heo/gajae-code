# opt-cold-unlikely

> Mark unlikely code paths with `#[cold]` to help compiler optimization

## Why It Matters

The `#[cold]` attribute tells the compiler that a function is rarely called. The compiler uses this to optimize code layout—keeping cold code away from hot code improves instruction cache utilization. Combined with branch layout optimization, this can measurably improve performance.

## Bad

```rust
// All branches treated equally
fn validate(input: &str) -> Result<Data, ValidationError> {
    if input.is_empty() {
        return Err(ValidationError::Empty);  // Rare
    }
    
    if input.len() > 1000 {
        return Err(ValidationError::TooLong);  // Rare  
    }
    
    if !input.is_ascii() {
        return Err(ValidationError::NonAscii);  // Rare
    }
    
    // This is the common case
    Ok(parse_data(input))
}
```

## Good

```rust
fn validate(input: &str) -> Result<Data, ValidationError> {
    if input.is_empty() {
        return cold_empty_error();
    }
    
    if input.len() > 1000 {
        return cold_too_long_error();
    }
    
    if !input.is_ascii() {
        return cold_non_ascii_error();
    }
    
    Ok(parse_data(input))
}

#[cold]
fn cold_empty_error() -> Result<Data, ValidationError> {
    Err(ValidationError::Empty)
}

#[cold]
fn cold_too_long_error() -> Result<Data, ValidationError> {
    Err(ValidationError::TooLong)
}

#[cold]
fn cold_non_ascii_error() -> Result<Data, ValidationError> {
    Err(ValidationError::NonAscii)
}
```

## What #[cold] Does

1. **Code placement**: Cold functions are placed in separate code sections, away from hot code
2. **Branch prediction**: Compiler generates branch hints favoring the non-cold path
3. **Inlining decisions**: Cold functions are not inlined into hot paths
4. **Optimization budget**: Compiler spends less effort optimizing cold code

## Common Cold Patterns

```rust
// Error handling
#[cold]
fn handle_error<E: std::fmt::Display>(e: E) -> ! {
    eprintln!("Fatal error: {}", e);
    std::process::exit(1);
}

// Logging rare events
#[cold]
fn log_rare_event(event: &Event) {
    log::warn!("Rare event occurred: {:?}", event);
}

// Fallback paths
#[cold]
fn slow_fallback(data: &Data) -> Output {
    // This path should rarely be taken
    compute_slowly(data)
}

// Panic handlers
#[cold]
fn panic_invalid_state(state: &State) -> ! {
    panic!("Invalid state: {:?}", state);
}
```

## Assertions and Invariants

```rust
fn get_unchecked(&self, index: usize) -> &T {
    if index >= self.len {
        cold_bounds_panic(index, self.len);
    }
    unsafe { &*self.ptr.add(index) }
}

#[cold]
#[inline(never)]
fn cold_bounds_panic(index: usize, len: usize) -> ! {
    panic!("index out of bounds: the len is {} but the index is {}", len, index);
}
```

## Combining with #[inline(never)]

```rust
// Usually combine both for maximum effect
#[cold]
#[inline(never)]
fn error_path() -> Error {
    // Complex error construction stays out of hot code
    Error {
        backtrace: Backtrace::capture(),
        context: gather_context(),
    }
}
```

## Measuring Impact

```rust
// Check code layout with objdump
// objdump -d target/release/binary | less

// Look for .cold sections
// nm target/release/binary | grep cold

// Profile to verify improvement
// perf stat -e cache-misses,cache-references ./binary
```

## See Also

- [opt-inline-never-cold](./opt-inline-never-cold.md) - Combining with inline(never)
- [opt-likely-hint](./opt-likely-hint.md) - Branch prediction hints
- [err-result-over-panic](./err-result-over-panic.md) - Error handling
