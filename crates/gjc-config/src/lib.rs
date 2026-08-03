//! Config-directory resolution and settings loading for the `gjc` binary.
//!
//! Ports (parity is the contract — see `docs/roadmap/full-conversion-to-rust.md`):
//! - `packages/utils/src/env-file.ts` → [`env_file`]
//! - `packages/utils/src/dirs.ts` → [`dirs`]
//! - `packages/coding-agent/src/config/settings-schema.ts` → [`settings_schema`]
//!   (via the generated `schemas/settings-flat.json`)
//! - `packages/coding-agent/src/config/settings.ts` (read path) → [`settings`]
//! - `packages/coding-agent/src/cli/config-cli.ts` (redaction) → [`secrets`]

pub mod dirs;
pub mod env_file;
pub mod secrets;
pub mod settings;
pub mod settings_schema;
