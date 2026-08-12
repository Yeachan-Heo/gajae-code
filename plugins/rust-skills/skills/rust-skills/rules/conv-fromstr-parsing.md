# conv-fromstr-parsing

> Implement `FromStr` to enable `str::parse` for string-to-type conversions

## Why It Matters

`FromStr` is the single standard hook for parsing a `&str` into a typed value. Implementing it unlocks the idiomatic `.parse::<T>()` call, integrates with CLI argument parsers (clap, argh), and is the expected interface for serde string-deserializable types. A bespoke `fn parse_foo(s: &str)` forces callers to learn a private name and breaks generic code that constrains `T: FromStr`.

## Bad

```rust
#[derive(Debug)]
enum Color { Red, Green, Blue }

// Callers must know this private name; no `.parse()` support
fn parse_color(s: &str) -> Result<Color, String> {
    match s {
        "red"   => Ok(Color::Red),
        "green" => Ok(Color::Green),
        "blue"  => Ok(Color::Blue),
        other   => Err(format!("unknown color: {other}")),
    }
}

fn main() {
    let c = parse_color("red").unwrap();
}
```

## Good

```rust
use std::str::FromStr;
use std::fmt;

#[derive(Debug, PartialEq)]
enum Color { Red, Green, Blue }

#[derive(Debug)]
struct ParseColorError(String);

impl fmt::Display for ParseColorError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "unknown color: {}", self.0)
    }
}

impl std::error::Error for ParseColorError {}

impl FromStr for Color {
    type Err = ParseColorError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "red"   => Ok(Color::Red),
            "green" => Ok(Color::Green),
            "blue"  => Ok(Color::Blue),
            other   => Err(ParseColorError(other.to_owned())),
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Standard idiom — works with clap, config parsers, etc.
    let c: Color = "green".parse()?;
    assert_eq!(c, Color::Green);
    Ok(())
}
```

## Notes

- Use a concrete `Err` type, not `String`, so callers can pattern-match on parse failures.
- `FromStr` pairs naturally with `Display`: if you can parse it in, you should be able to print it out.
- For infallible string conversions (e.g., wrapping a `String` in a newtype), consider `From<&str>` or `From<String>` instead.
- CLI crates like `clap` detect `FromStr` automatically via the `value_parser` attribute macro.

## See Also

- [conv-tryfrom-fallible](conv-tryfrom-fallible.md) - `TryFrom` for fallible non-string conversions
- [type-newtype-validated](type-newtype-validated.md) - newtypes for validated data like `Email`, `Url`
- [api-parse-dont-validate](api-parse-dont-validate.md) - parse into validated types at boundaries
