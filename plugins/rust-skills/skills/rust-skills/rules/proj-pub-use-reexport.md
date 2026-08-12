# proj-pub-use-reexport

> Use pub use for clean public API

## Why It Matters

`pub use` re-exports items from submodules at the current module level. This creates a flat, ergonomic public API while keeping internal organization flexible. Users import from one place; you can reorganize internals without breaking their code.

## Bad

```rust
// lib.rs - Deep module paths exposed
pub mod error;
pub mod config;
pub mod client;
pub mod types;

// Users must write:
use my_crate::error::MyError;
use my_crate::config::Config;
use my_crate::client::http::HttpClient;
use my_crate::types::request::Request;
```

## Good

```rust
// lib.rs - Flat public API
mod error;
mod config;
mod client;
mod types;

pub use error::MyError;
pub use config::Config;
pub use client::http::HttpClient;
pub use types::request::Request;

// Users write:
use my_crate::{Config, HttpClient, MyError, Request};
```

## Pattern: Selective Re-export

```rust
// src/lib.rs
mod internal;

// Only re-export what users need
pub use internal::{
    PublicStruct,
    PublicTrait,
    public_function,
};

// Keep implementation details hidden
// internal::helper_function is NOT exported
```

## Pattern: Rename on Re-export

```rust
mod v1 {
    pub struct Client { /* old implementation */ }
}

mod v2 {
    pub struct Client { /* new implementation */ }
}

// Re-export with clear names
pub use v2::Client;
pub use v1::Client as LegacyClient;
```

## Pattern: Prelude Module

```rust
// src/lib.rs
pub mod prelude {
    pub use crate::{
        Config,
        Client,
        Error,
        Request,
        Response,
    };
}

// Users can glob import common items
use my_crate::prelude::*;
```

## Pattern: Feature-Gated Re-exports

```rust
// src/lib.rs
mod core;
mod serde_impl;
mod async_impl;

pub use core::*;

#[cfg(feature = "serde")]
pub use serde_impl::*;

#[cfg(feature = "async")]
pub use async_impl::*;
```

## Comparison: Module Structure vs Public API

```rust
// Internal structure (complex)
src/
├── transport/
│   ├── http/
│   │   └── client.rs    // HttpClient
│   └── grpc/
│       └── client.rs    // GrpcClient
├── auth/
│   └── token.rs         // Token
└── lib.rs

// Public API (flat)
pub use transport::http::client::HttpClient;
pub use transport::grpc::client::GrpcClient;
pub use auth::token::Token;

// Users see:
my_crate::HttpClient
my_crate::GrpcClient
my_crate::Token
```

## Re-export External Types

```rust
// Re-export dependencies users will need
pub use bytes::Bytes;
pub use http::{Method, StatusCode};

// Now users don't need to depend on these crates directly
```

## Glob Re-exports

Use sparingly:

```rust
// OK for internal modules
pub use internal::*;

// Careful with external crates - pollutes namespace
pub use serde::*;  // Usually too broad
```

## See Also

- [proj-prelude-module](./proj-prelude-module.md) - Prelude pattern
- [proj-pub-crate-internal](./proj-pub-crate-internal.md) - Internal visibility
- [api-non-exhaustive](./api-non-exhaustive.md) - API stability
