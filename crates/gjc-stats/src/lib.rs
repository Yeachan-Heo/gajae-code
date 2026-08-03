//! Usage-stats pure logic for the `gjc` binary.
//!
//! Ports of `packages/stats` (parity is the contract — see
//! `docs/roadmap/full-conversion-to-rust.md`):
//! - `user-metrics.ts` → [`user_metrics`] (validated against vectors generated
//!   by the TS implementation)
//!
//! Deliberately skipped for now (documented deferrals):
//! - `db.ts`, history storage — `SQLite` access; lands with the storage phase
//!   to avoid a premature rusqlite/sqlx dependency decision
//! - `parser.ts`, `aggregator.ts` — depend on `@gajae-code/ai` message types;
//!   ported with the phase 2 provider layer
//! - `server.ts`, `sync-worker.ts`, `compiled-client-assets.ts` — Bun HTTP
//!   server and worker runtime; replaced by the Rust host later
//! - `types.ts` / `shared-types.ts` — wire contracts follow their consumers

pub mod user_metrics;
