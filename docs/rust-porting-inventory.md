# Rust porting inventory

Tracks every candidate for moving gjc hot paths and TypeScript implementations
into the native addon (`crates/pi-natives` via `@gajae-code/natives`), whether
vendored from upstream or hand-ported after profiling.

Upstream pin: `can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1`

- Upstream sources are read only at this commit
  (`https://raw.githubusercontent.com/can1357/oh-my-pi/<pin>/<path>`), never from `main`.
- Every vendored file carries an attribution header naming this commit, unless its
  row below records a per-row bump made by the PR that needed newer code.
- Upstream is MIT licensed; vendored crates keep their `LICENSE` and are listed in `NOTICE.md`.
- `docs/rust-porting/upstream-workspace-deps@a85bd522.toml` is a verbatim snapshot of the
  upstream root `[workspace.dependencies]` at the pin. `bun scripts/verify-rust-porting-inventory.ts --deps`
  checks the local workspace against it.

## Status vocabulary

| Status | Meaning |
|---|---|
| `candidate` | Listed, not started. |
| `in-progress` | PR open, or crate landed but some consumers are not wired yet. |
| `adopted` | Merged with parity, benchmark, and rehearsal evidence; replaced TS deleted with no fallback. |
| `rejected` | Not adopted; `reason` is mandatory. |
| `keep-local` | gjc-only Rust that a re-sync must not overwrite; guarded by named tests. |

## Phase log

| Phase | Status | PR | Rehearsal run | Notes |
|---|---|---|---|---|
| 0 — toolchain and shared deps at pin | in-progress | | | `nightly-2026-08-12`; shared workspace deps aligned to the pin. |

## Inventory tables

Tables A–E (upstream-only crates, upstream-only `pi-natives` modules, overlap drift,
keep-local ledger, hot-path candidates) are written in Phase 1b.
