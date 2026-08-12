# macro-fragment-specifiers

> Capture with precise fragment specifiers, not raw `:tt`, where you can

## Why It Matters

Fragment specifiers tell the compiler — and readers — exactly what syntactic category a macro arm expects. They produce targeted error messages ("expected expression" instead of "no rules expected token"), enable better IDE tooling, and prevent ambiguous parses. Using raw `:tt` (token tree) forces you to re-parse or validate by hand and leaks implementation details into error messages.

Note the **follow-set restriction**: after `:expr`, `:ty`, `:pat`, and a few others, only a limited set of tokens may appear — most commonly `=>`, `,`, `;`, `|`, or another fragment. Plan your separator tokens accordingly.

## Bad

```rust
// Slurping everything as :tt, then trying to use $e as if it were an expression.
macro_rules! debug_val {
    ($($t:tt)*) => {
        println!("{} = {:?}", stringify!($($t)*), $($t)*);
        //                                          ^^^^^^^^ re-expanding :tt soup
    };
}

fn main() {
    debug_val!(1 + 2);      // works by accident
    debug_val!(let x = 1);  // accepted by the macro; blows up at expansion
}
```

## Good

```rust
macro_rules! debug_val {
    // :expr captures a single expression; the follow-set allows `=>` and `,` after it.
    ($e:expr) => {
        println!("{} = {:?}", stringify!($e), $e);
    };
}

fn main() {
    debug_val!(1 + 2);
    // debug_val!(let x = 1); // now correctly rejected at the macro call site
}
```

## Fragment Specifier Reference

| Specifier | Matches | Common uses |
|-----------|---------|-------------|
| `:expr` | An expression | Values, arithmetic, closures |
| `:ty` | A type | Generic helpers, type aliases |
| `:ident` | An identifier | Field names, variable names |
| `:pat` | A pattern | `match` arm patterns |
| `:pat_param` | A pattern (no `|` at top level) | Fn param patterns |
| `:path` | A path (`a::b::c`) | Trait bounds, type paths |
| `:literal` | A literal (`42`, `"hi"`) | Constant values |
| `:block` | A `{ ... }` block | Inline code injection |
| `:stmt` | A statement | Statement-level macros |
| `:meta` | A meta item | `#[derive(Clone)]` content |
| `:vis` | A visibility qualifier | `pub`, `pub(crate)` |
| `:lifetime` | A lifetime (`'a`) | Generic lifetime params |
| `:tt` | Any single token tree | Last resort; combinators |

## Trailing-Comma Pattern

Allow an optional trailing comma in repetitions without requiring a follow-set workaround:

```rust
macro_rules! my_vec {
    ($($e:expr),* $(,)?) => {
        // $(,)? consumes an optional trailing comma, which is legal after :expr
        // because it appears as a separator/terminator, not in follow position.
        vec![$($e),*]
    };
}

let v = my_vec![1, 2, 3,]; // trailing comma accepted
```

## See Also

- [macro-rules-hygiene](macro-rules-hygiene.md) - hygiene and `$crate` for declarative macros
- [macro-prefer-functions](macro-prefer-functions.md) - when a function is a better choice
