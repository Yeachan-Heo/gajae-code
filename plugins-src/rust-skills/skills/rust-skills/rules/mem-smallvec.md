# mem-smallvec

> Use `SmallVec` for usually-small collections

## Why It Matters

`SmallVec<[T; N]>` stores up to N elements inline (on the stack), only allocating on the heap when the size exceeds N. This eliminates heap allocations for the common case while still allowing growth when needed.

## Bad

```rust
// Always heap-allocates, even for 1-2 elements
fn get_path_components(path: &str) -> Vec<&str> {
    path.split('/').collect()  // Usually 2-4 components
}

// Always heap-allocates for error list
fn validate(input: &Input) -> Vec<ValidationError> {
    let mut errors = Vec::new();  // Usually 0-3 errors
    // validation logic...
    errors
}
```

## Good

```rust
use smallvec::{smallvec, SmallVec};

// Stack-allocated for typical paths (1-8 components)
fn get_path_components(path: &str) -> SmallVec<[&str; 8]> {
    path.split('/').collect()
}

// Stack-allocated for typical error counts
fn validate(input: &Input) -> SmallVec<[ValidationError; 4]> {
    let mut errors = SmallVec::new();
    // validation logic...
    errors
}

// Using smallvec! macro
let v: SmallVec<[i32; 4]> = smallvec![1, 2, 3];
```

## Choosing Capacity N

```rust
// Measure your actual data distribution!
// Guidelines:

// Path components: 4-8 (most paths are shallow)
type PathParts<'a> = SmallVec<[&'a str; 8]>;

// Function arguments: 4-8 (most functions have few args)  
type Args = SmallVec<[Arg; 8]>;

// AST children: 2-4 (binary ops, if/else, etc.)
type Children = SmallVec<[Node; 4]>;

// Error accumulation: 2-4 (most inputs have few errors)
type Errors = SmallVec<[Error; 4]>;

// Attribute lists: 4-8 (most items have few attributes)
type Attrs = SmallVec<[Attribute; 8]>;
```

## Evidence from rust-analyzer

```rust
// https://github.com/rust-lang/rust/blob/main/compiler/rustc_expand/src/base.rs
macro_rules! make_stmts_default {
    ($me:expr) => {
        $me.make_expr().map(|e| {
            smallvec![ast::Stmt {
                id: ast::DUMMY_NODE_ID,
                span: e.span,
                kind: ast::StmtKind::Expr(e),
            }]
        })
    }
}
```

## Trade-offs

```rust
// SmallVec is slightly larger than Vec
use std::mem::size_of;
// Vec<i32>: 24 bytes (ptr + len + cap)
// SmallVec<[i32; 4]>: 32 bytes (inline storage + len + discriminant)

// SmallVec has branching overhead on every operation
// (must check if inline or heap)

// Profile to verify benefit!
```

## When to Use SmallVec vs Alternatives

| Situation | Use |
|-----------|-----|
| Usually small, sometimes large | `SmallVec<[T; N]>` |
| Always small, fixed max | `ArrayVec<T, N>` |
| Rarely grows past initial | `Vec::with_capacity` |
| No `unsafe` allowed | `TinyVec` |
| Often empty | `ThinVec` |

## ArrayVec Alternative

```rust
use arrayvec::ArrayVec;

// Fixed maximum capacity, never heap allocates
// Panics if you exceed capacity
fn parse_rgb(s: &str) -> ArrayVec<u8, 3> {
    let mut components = ArrayVec::new();
    for part in s.split(',').take(3) {
        components.push(part.parse().unwrap());
    }
    components
}
```

## TinyVec (No Unsafe)

```rust
use tinyvec::{tiny_vec, TinyVec};

// Same concept as SmallVec but 100% safe code
let v: TinyVec<[i32; 4]> = tiny_vec![1, 2, 3];
```

## See Also

- [mem-arrayvec](mem-arrayvec.md) - Use ArrayVec for fixed-max collections
- [mem-with-capacity](mem-with-capacity.md) - Pre-allocate when size is known
- [mem-thinvec](mem-thinvec.md) - Use ThinVec for often-empty vectors
