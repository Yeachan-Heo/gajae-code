//! Read-only access to the on-disk session store.
//!
//! Ports the read paths of `packages/coding-agent/src/session` (parity is the
//! contract — see `docs/roadmap/full-conversion-to-rust.md`):
//! - managed scope directory naming (`internal/managed-session-scope.ts`:
//!   `scopeDigest`, the `v2-<digest>` layout, and the binding file)
//! - transcript JSONL parsing (`session-manager.ts` write format)
//!
//! Deliberately not ported (write-side authority stays Bun-side for now):
//! managed-scope creation/verification, ACL/ownership security checks, legacy
//! directory-name migration, deletion, and forking.

pub mod scope;
pub mod transcript;
