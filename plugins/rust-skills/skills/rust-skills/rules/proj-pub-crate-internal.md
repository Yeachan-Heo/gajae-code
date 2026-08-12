# proj-pub-crate-internal

> Use pub(crate) for internal APIs

## Why It Matters

`pub(crate)` exposes items within the crate but hides them from external users. This creates clear boundaries between public API and internal implementation, preventing accidental breakage and reducing public API surface.

## Bad

```rust
// Everything public - users depend on internals
pub mod internal {
    pub struct InternalState {
        pub buffer: Vec<u8>,    // Implementation detail exposed
        pub dirty: bool,
    }
    
    pub fn process_internal(state: &mut InternalState) {
        // Users can call this, creating coupling
    }
}

pub struct Widget {
    pub state: internal::InternalState,  // Exposed!
}
```

## Good

```rust
// Internal module with crate visibility
pub(crate) mod internal {
    pub(crate) struct InternalState {
        pub(crate) buffer: Vec<u8>,
        pub(crate) dirty: bool,
    }
    
    pub(crate) fn process_internal(state: &mut InternalState) {
        // Only callable within crate
    }
}

pub struct Widget {
    state: internal::InternalState,  // Private field
}

impl Widget {
    pub fn new() -> Self {
        Self {
            state: internal::InternalState {
                buffer: Vec::new(),
                dirty: false,
            }
        }
    }
    
    pub fn do_something(&mut self) {
        internal::process_internal(&mut self.state);
    }
}
```

## Visibility Levels

| Visibility | Accessible From |
|------------|-----------------|
| `pub` | Everywhere |
| `pub(crate)` | Current crate only |
| `pub(super)` | Parent module only |
| `pub(in path)` | Specific module path |
| (private) | Current module only |

## Pattern: Internal Module

```rust
// src/lib.rs
mod internal;  // Private module
pub mod api;   // Public API

// src/internal.rs
pub(crate) struct Helper;
pub(crate) fn helper_function() -> Helper { Helper }

// src/api.rs
use crate::internal::{Helper, helper_function};

pub struct PublicType {
    helper: Helper,  // Uses internal type, but field is private
}
```

## Pattern: Test Visibility

```rust
pub struct Parser {
    // Private implementation
    state: ParserState,
}

// Expose for testing but not public API
#[cfg(test)]
pub(crate) fn debug_state(&self) -> &ParserState {
    &self.state
}

// Or use a dedicated test helper
#[doc(hidden)]
pub mod __test_helpers {
    pub use super::ParserState;
}
```

## Pattern: Feature Module Internals

```rust
// src/user/mod.rs
mod repository;  // Private
mod service;     // Private

pub use service::UserService;  // Only export the public API

// repository and service are pub(crate) internally
// so other modules in crate can use them if needed
```

## Benefits

| Approach | API Stability | Flexibility |
|----------|---------------|-------------|
| All `pub` | Any change breaks users | None |
| `pub(crate)` internals | Only `pub` items matter | Can refactor freely |
| Private | Maximum encapsulation | Limits crate flexibility |

## See Also

- [proj-pub-super-parent](./proj-pub-super-parent.md) - Parent-only visibility
- [proj-pub-use-reexport](./proj-pub-use-reexport.md) - Clean re-exports
- [api-non-exhaustive](./api-non-exhaustive.md) - Future-proof structs
