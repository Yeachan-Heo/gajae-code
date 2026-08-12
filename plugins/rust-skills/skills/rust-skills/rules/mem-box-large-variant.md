# mem-box-large-variant

> Box large enum variants to reduce overall enum size

## Why It Matters

An enum's size is determined by its largest variant. If one variant contains a large struct while others are small, every instance of the enum pays for the largest variant's size. Boxing the large variant puts that data on the heap, keeping the enum itself small. This can significantly reduce memory usage and improve cache performance.

## Bad

```rust
enum Message {
    Quit,                              // 0 bytes of data
    Move { x: i32, y: i32 },          // 8 bytes
    Text(String),                      // 24 bytes
    Image { 
        data: [u8; 1024],             // 1024 bytes - forces entire enum to ~1032 bytes!
        width: u32, 
        height: u32 
    },
}

// Every Message is ~1032 bytes, even Quit and Move
let messages: Vec<Message> = vec![
    Message::Quit,  // Wastes ~1032 bytes
    Message::Quit,  // Wastes ~1032 bytes
    Message::Move { x: 0, y: 0 },  // Wastes ~1024 bytes
];
```

## Good

```rust
struct ImageData {
    data: [u8; 1024],
    width: u32,
    height: u32,
}

enum Message {
    Quit,
    Move { x: i32, y: i32 },
    Text(String),
    Image(Box<ImageData>),  // Now just 8 bytes (pointer)
}

// Message is now ~32 bytes (String variant is largest)
let messages: Vec<Message> = vec![
    Message::Quit,  // Uses ~32 bytes
    Message::Quit,  // Uses ~32 bytes  
    Message::Move { x: 0, y: 0 },  // Uses ~32 bytes
];
```

## Check Enum Sizes

```rust
use std::mem::size_of;

// Before boxing
enum BadEvent {
    Click { x: u32, y: u32 },           // 8 bytes
    KeyPress(char),                      // 4 bytes
    LargeData([u8; 256]),               // 256 bytes
}
println!("BadEvent: {} bytes", size_of::<BadEvent>());  // ~264 bytes

// After boxing
enum GoodEvent {
    Click { x: u32, y: u32 },
    KeyPress(char),
    LargeData(Box<[u8; 256]>),          // 8 bytes (pointer)
}
println!("GoodEvent: {} bytes", size_of::<GoodEvent>());  // ~16 bytes
```

## Clippy Lint

```toml
[lints.clippy]
large_enum_variant = "warn"  # Warns when variants differ significantly
```

```rust
// Clippy will suggest:
// warning: large size difference between variants
// help: consider boxing the large fields to reduce the total size
```

## When to Box

| Largest Variant | Other Variants | Action |
|-----------------|----------------|--------|
| < 64 bytes | Similar size | Don't box |
| > 128 bytes | Much smaller | Box the large variant |
| > 256 bytes | Any | Definitely box |

## Recursive Types Require Boxing

```rust
// Won't compile - infinite size
enum List {
    Cons(i32, List),
    Nil,
}

// Must box recursive variant
enum List {
    Cons(i32, Box<List>),  // Now finite size
    Nil,
}

// Same for ASTs
enum Expr {
    Number(i64),
    BinOp {
        op: Op,
        left: Box<Expr>,   // Recursive - must box
        right: Box<Expr>,
    },
}
```

## Pattern Matching with Boxed Variants

```rust
enum Event {
    Small(u32),
    Large(Box<LargeData>),
}

fn handle(event: Event) {
    match event {
        Event::Small(n) => println!("Small: {}", n),
        Event::Large(data) => {
            // data is Box<LargeData>, dereference to access
            println!("Large: {} bytes", data.size);
        }
    }
}

// Or match on reference
fn handle_ref(event: &Event) {
    match event {
        Event::Small(n) => println!("Small: {}", n),
        Event::Large(data) => {
            // data is &Box<LargeData>, auto-derefs
            println!("Large: {} bytes", data.size);
        }
    }
}
```

## See Also

- [own-move-large](./own-move-large.md) - Boxing large types for cheap moves
- [mem-smallvec](./mem-smallvec.md) - Alternative for inline small collections
- [lint-deny-correctness](./lint-deny-correctness.md) - Enabling clippy lints
