//! NAPI-free core of `pi-natives`.
//!
//! Modules migrate here from `crates/pi-natives` one by one (roadmap phase 1,
//! `docs/roadmap/full-conversion-to-rust.md`): the algorithmic core lives
//! here with plain-Rust types, while `pi-natives` keeps a thin NAPI facade
//! with unchanged export names and signatures for the Bun runtime. The `gjc`
//! host binary consumes this crate directly, with no `napi` in its
//! dependency tree.
//!
//! Migrated so far: [`glob_util`], [`hashline`], [`linediff`].
//!
//! Facade-resident by design (JS-interop-specific code stays in
//! `pi-natives`): `JsString`/UTF-16 zero-copy entry points, `Utf16String`
//! construction, and NAPI object structs.

pub mod glob_util;
pub mod hashline;
pub mod linediff;
