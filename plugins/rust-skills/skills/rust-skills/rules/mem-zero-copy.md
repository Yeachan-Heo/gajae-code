# mem-zero-copy

> Use zero-copy patterns with slices and `Bytes`

## Why It Matters

Zero-copy means working with data without copying it. Instead of allocating new memory and copying bytes, you work with references to the original data. This dramatically reduces memory usage and improves performance, especially for large data.

## Bad

```rust
// Copies every line into a new String
fn get_lines(data: &str) -> Vec<String> {
    data.lines()
        .map(|line| line.to_string())  // Allocates!
        .collect()
}

// Copies the entire buffer
fn process_packet(buffer: &[u8]) -> Vec<u8> {
    let header = buffer[0..16].to_vec();  // Copy!
    let body = buffer[16..].to_vec();      // Copy!
    // Process...
    [header, body].concat()  // Another copy!
}
```

## Good

```rust
// Zero-copy: returns references to original data
fn get_lines(data: &str) -> Vec<&str> {
    data.lines().collect()  // Just pointers!
}

// Zero-copy with slices
fn process_packet(buffer: &[u8]) -> (&[u8], &[u8]) {
    let header = &buffer[0..16];  // Just a pointer + length
    let body = &buffer[16..];     // Just a pointer + length
    (header, body)
}
```

## Using bytes::Bytes

```rust
use bytes::Bytes;

// Bytes provides zero-copy slicing with reference counting
let data = Bytes::from("hello world");

// Slicing doesn't copy - just increments refcount
let hello = data.slice(0..5);   // Zero-copy!
let world = data.slice(6..11); // Zero-copy!

// Both hello and world share the underlying allocation
// Memory is freed when all references are dropped
```

## Common Pattern: Cow for Static Strings

A common pattern — seen in HTTP servers and similar code — returns
`Cow<'static, str>` to avoid allocating for well-known static values:

```rust
fn method_to_cow(method: &http::Method) -> Cow<'static, str> {
    match *method {
        Method::GET => Cow::Borrowed("GET"),      // Zero-copy
        Method::POST => Cow::Borrowed("POST"),    // Zero-copy
        Method::PUT => Cow::Borrowed("PUT"),      // Zero-copy
        _ => Cow::Owned(method.to_string()),      // Only copies for rare methods
    }
}
```

## Zero-Copy Parsing

```rust
// Bad: Copies each parsed field
struct ParsedBad {
    name: String,
    value: String,
}

fn parse_bad(input: &str) -> ParsedBad {
    let (name, value) = input.split_once('=').unwrap();
    ParsedBad {
        name: name.to_string(),   // Copy!
        value: value.to_string(), // Copy!
    }
}

// Good: References into original string
struct Parsed<'a> {
    name: &'a str,
    value: &'a str,
}

fn parse_good(input: &str) -> Parsed<'_> {
    let (name, value) = input.split_once('=').unwrap();
    Parsed { name, value }  // Zero-copy!
}
```

## Combining with Cow

```rust
use std::borrow::Cow;

// Zero-copy when possible, copy when needed
fn normalize<'a>(input: &'a str) -> Cow<'a, str> {
    if input.contains('\t') {
        // Must copy to modify
        Cow::Owned(input.replace('\t', "    "))
    } else {
        // Zero-copy reference
        Cow::Borrowed(input)
    }
}
```

## memchr for Fast Searching

```rust
use memchr::memchr;

// Fast byte search using SIMD
fn find_newline(data: &[u8]) -> Option<usize> {
    memchr(b'\n', data)  // SIMD-accelerated, no allocation
}

// Find all occurrences
use memchr::memchr_iter;

fn count_newlines(data: &[u8]) -> usize {
    memchr_iter(b'\n', data).count()
}
```

## When Zero-Copy Isn't Possible

```rust
// Need to modify data - must copy
fn uppercase(s: &str) -> String {
    s.to_uppercase()  // Creates new String
}

// Need data to outlive source
fn store_for_later(s: &str) -> String {
    s.to_string()  // Must copy for ownership
}

// Cross-thread transfer (without Arc)
fn send_to_thread(data: &[u8]) {
    let owned = data.to_vec();  // Must copy
    std::thread::spawn(move || {
        process(&owned);
    });
}
```

## See Also

- [own-cow-conditional](own-cow-conditional.md) - Use Cow for conditional ownership
- [own-borrow-over-clone](own-borrow-over-clone.md) - Prefer borrowing over cloning
- [mem-arena-allocator](mem-arena-allocator.md) - Arena allocators for batch operations
