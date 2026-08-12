# own-move-large

> Move large types instead of copying; use `Box` if moves are expensive

## Why It Matters

In Rust, "moving" a value means copying its bytes to a new location and invalidating the old one. For large types (hundreds of bytes), this memcpy can be expensive. Boxing large types reduces move cost to copying a single pointer (8 bytes), making moves cheap regardless of the actual data size.

## Bad

```rust
// Large struct moved repeatedly = expensive memcpy each time
struct GameState {
    board: [[Cell; 100]; 100],  // 10,000 cells
    history: [Move; 1000],       // 1,000 moves
    players: [Player; 4],        // Player data
    // Total: potentially tens of KB
}

fn process_state(state: GameState) -> GameState {
    // Moving ~40KB+ of data
    let mut new_state = state;  // Memcpy here
    new_state.apply_rules();
    new_state  // Memcpy on return
}

let state = GameState::new();
let state = process_state(state);  // Two large memcpys
```

## Good

```rust
// Box reduces move cost to 8 bytes
struct GameState {
    board: Box<[[Cell; 100]; 100]>,  // Pointer to heap
    history: Vec<Move>,               // Already heap-allocated
    players: [Player; 4],
}

fn process_state(mut state: GameState) -> GameState {
    // Moving just pointers + small inline data
    state.apply_rules();
    state  // Cheap move
}

// Or use Box at call site for one-off cases
fn process_large(state: Box<LargeStruct>) -> Box<LargeStruct> {
    // 8-byte move regardless of LargeStruct size
    state
}
```

## When to Box

| Type Size | Move Frequency | Recommendation |
|-----------|----------------|----------------|
| < 128 bytes | Any | Don't box |
| 128-512 bytes | Rare | Probably don't box |
| 128-512 bytes | Frequent | Consider boxing |
| > 512 bytes | Any | Box or use references |
| > 4KB | Any | Definitely box |

## Stack vs Heap Tradeoffs

```rust
// Stack: fast allocation, limited size, moves copy bytes
struct StackHeavy {
    data: [u8; 4096],  // 4KB on stack
}

// Heap: allocation cost, unlimited size, moves copy pointer
struct HeapLight {
    data: Box<[u8; 4096]>,  // 8 bytes on stack, 4KB on heap
}

// Measure with size_of
use std::mem::size_of;
assert_eq!(size_of::<StackHeavy>(), 4096);
assert_eq!(size_of::<HeapLight>(), 8);
```

## Alternative: References

When you don't need ownership transfer, use references:

```rust
// Best: no move at all
fn analyze_state(state: &GameState) -> Analysis {
    // Borrows state, no copying
    compute_analysis(state)
}

// Mutable borrow for in-place modification
fn update_state(state: &mut GameState) {
    state.tick();
}
```

## Pattern: Builder Returns Boxed

```rust
impl LargeConfig {
    pub fn builder() -> ConfigBuilder {
        ConfigBuilder::default()
    }
}

impl ConfigBuilder {
    // Return boxed to avoid large move
    pub fn build(self) -> Box<LargeConfig> {
        Box::new(LargeConfig {
            // ... fields from builder
        })
    }
}
```

## Profile First

Don't prematurely optimize. Use tools to identify if moves are actually a bottleneck:

```rust
// Check type sizes
println!("Size of GameState: {}", std::mem::size_of::<GameState>());

// Profile with cargo flamegraph or perf to find hot memcpys
```

## See Also

- [own-copy-small](./own-copy-small.md) - Cheap types should be Copy
- [mem-box-large-variant](./mem-box-large-variant.md) - Boxing enum variants
- [perf-profile-first](./perf-profile-first.md) - Measure before optimizing
