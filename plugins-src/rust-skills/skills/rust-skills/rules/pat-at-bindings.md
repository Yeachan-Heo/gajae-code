# pat-at-bindings

> Use `@` bindings to capture a value while matching it against a pattern

## Why It Matters

The `name @ pattern` syntax binds the matched value to `name` and simultaneously tests it against `pattern` in a single arm. Without `@`, you either re-access the original expression (verbose) or add a guard that repeats the condition and re-extracts the value (redundant). `@` bindings make the constraint and the binding a single, readable unit.

## Bad

```rust
fn classify(n: u32) -> String {
    match n {
        1..=9 => format!("single digit: {n}"), // fine here — n is Copy and in scope
        10..=99 => {
            let tens = n; // no real benefit; contrived but shows the pattern
            format!("two digits: {tens}")
        }
        _ => String::from("large"),
    }
}

// More revealing: nested struct field — must re-access after matching range
#[derive(Debug)]
enum Command {
    Move { x: i32, y: i32 },
}

fn validate_move(cmd: &Command) {
    match cmd {
        Command::Move { x, y } if *x >= 0 && *x <= 100 => {
            // x is already bound, so this is fine, but the guard duplicates the range
            println!("valid move to x={x}, y={y}");
        }
        _ => println!("invalid command"),
    }
}
```

## Good

```rust
fn classify(n: u32) -> String {
    match n {
        id @ 1..=9 => format!("single digit: {id}"),
        id @ 10..=99 => format!("two digits: {id}"),
        _ => String::from("large"),
    }
}

// Nested struct field with @ binding
#[derive(Debug)]
enum Command {
    Move { x: i32, y: i32 },
}

fn validate_move(cmd: &Command) {
    match cmd {
        Command::Move { x: x_pos @ 0..=100, y } => {
            println!("valid move to x={x_pos}, y={y}");
        }
        _ => println!("invalid command"),
    }
}
```

`x: x_pos @ 0..=100` destructures the `x` field, checks that it falls in `0..=100`, and binds the value to `x_pos` — all in one expression.

## Binding an Enum Variant While Inspecting Its Payload

```rust
#[derive(Debug, Clone)]
enum Packet {
    Data(Vec<u8>),
    Control(u8),
}

fn log_data(packet: &Packet) {
    match packet {
        whole @ Packet::Data(bytes) if !bytes.is_empty() => {
            println!("non-empty packet: {whole:?}");
        }
        Packet::Data(_) => println!("empty data packet"),
        Packet::Control(code) => println!("control: {code}"),
    }
}
```

`whole` captures the entire `Packet::Data(...)` value while the guard checks the payload — no need to reconstruct the variant for logging.

## Notes

- `@` bindings work in all pattern positions: `match`, `if let`, `while let`, `let ... else`, and function parameters.
- Clippy lint `clippy::bind_instead_of_map` is unrelated but similarly reduces redundant re-access patterns.

## See Also

- [pat-exhaustive-enum](pat-exhaustive-enum.md) - match enums exhaustively to catch new variants
- [type-enum-states](type-enum-states.md) - use enums for mutually exclusive states
