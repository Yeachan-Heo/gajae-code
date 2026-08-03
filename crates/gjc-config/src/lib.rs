//! Config-directory resolution and settings loading for the `gjc` binary.
//!
//! Ports (parity is the contract — see `docs/roadmap/full-conversion-to-rust.md`):
//! - `packages/utils/src/env-file.ts` → [`env_file`]
//! - `packages/utils/src/dirs.ts` → [`dirs`]

pub mod dirs;
pub mod env_file;
