//! Dependency-light foundation helpers for the `gjc` binary.
//!
//! Ports of the mechanical leaf modules of `packages/utils/src` (parity is
//! the contract — see `docs/roadmap/full-conversion-to-rust.md`):
//! - `format.ts` → [`format`]
//! - `spawn-env.ts` → [`spawn_env`]
//! - `snowflake.ts` → [`snowflake`]
//! - `mime.ts` → [`mime`] (image metadata sniffing)
//!
//! Already ported elsewhere:
//! - `dirs.ts`, `env-file.ts` → `gjc-config`
//! - `sanitize-text.ts` → `pi-natives/src/text.rs` (`sanitize_text`)
//!
//! Deliberately skipped for now (Bun/runtime coupling or later-phase owner):
//! - `logger.ts`, `procmgr.ts`, `ptree.ts`, `stream.ts`, `broken-pipe.ts`,
//!   `abortable.ts`, `async.ts`, `temp.ts`, `hook-fetch.ts`, `fetch-retry.ts`,
//!   `postmortem.ts`, `prompt.ts`, `cli.ts` — process/IO runtime layers; the
//!   Rust host uses `tracing`/tokio idioms instead
//! - `frontmatter.ts` — needs a Bun.YAML-compatible parser corpus first;
//!   deferred to the skills port (phase 5)
//! - `glob.ts`, `which.ts`, `color.ts`, `tab-spacing.ts`, `ring.ts`,
//!   `peek-file.ts`, `json.ts`, `type-guards.ts`, `mermaid-ascii.ts`,
//!   `snowflake` UI consumers — ported on demand by their consuming phase

pub mod format;
pub mod mime;
pub mod snowflake;
pub mod spawn_env;
