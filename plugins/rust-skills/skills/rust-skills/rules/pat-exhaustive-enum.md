# pat-exhaustive-enum

> Match owned enums exhaustively; avoid catch-all `_` that hides new variants

## Why It Matters

A `_ =>` wildcard arm silently absorbs any variant added to an enum you own, converting what should be a compile-time error into a silent runtime no-op. Exhaustive matches let the compiler act as a checklist: add a variant, get a build failure everywhere it is unhandled. Reserve `_` and `..` for **foreign** `#[non_exhaustive]` enums, where the language requires a catch-all, and document why it is necessary.

## Bad

```rust
#[derive(Debug)]
enum Status {
    Active,
    Pending,
    Closed,
}

fn describe(s: &Status) -> &'static str {
    match s {
        Status::Active => "active",
        _ => "inactive", // hides Status::Pending silently; adding a new variant goes unnoticed
    }
}
```

If `Status::Suspended` is later added, `describe` compiles and silently returns `"inactive"` for it — a logic bug the compiler never catches.

## Good

```rust
#[derive(Debug)]
enum Status {
    Active,
    Pending,
    Closed,
}

fn describe(s: &Status) -> &'static str {
    match s {
        Status::Active => "active",
        Status::Pending => "pending",
        Status::Closed => "closed",
        // Adding Status::Suspended now causes a compile error here — intended.
    }
}
```

## Grouping Variants with `|`

When several variants share the same handling, list them explicitly rather than falling back to `_`:

```rust
fn is_terminal(s: &Status) -> bool {
    match s {
        Status::Closed | Status::Pending => true,
        Status::Active => false,
    }
}
```

## When `_` Is Required: Foreign `#[non_exhaustive]` Enums

External crates may mark enums `#[non_exhaustive]`, which means the compiler *forces* a wildcard. Document the intent:

```rust
// From a hypothetical external crate:
// #[non_exhaustive]
// pub enum TheirEvent { Click, Hover, /* ... future variants */ }

fn handle_event(event: &some_crate::TheirEvent) {
    match event {
        some_crate::TheirEvent::Click => { /* ... */ }
        some_crate::TheirEvent::Hover => { /* ... */ }
        // required by #[non_exhaustive]; intentionally a no-op for unknown variants
        _ => {}
    }
}
```

## Clippy Lint

`clippy::wildcard_enum_match_arm` (part of `clippy::restriction`) warns when a wildcard arm in a match on a non-`#[non_exhaustive]` enum could be replaced with explicit variants. Enabling it catches drift over time.

## See Also

- [api-non-exhaustive](api-non-exhaustive.md) - use `#[non_exhaustive]` for future-proof enums in public APIs
- [type-enum-states](type-enum-states.md) - use enums for mutually exclusive states
- [pat-matches-macro](pat-matches-macro.md) - boolean pattern tests with `matches!()`
