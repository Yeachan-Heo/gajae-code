//! NAPI facade over [`pi_natives_core::glob_util`].
//!
//! Moved there in the roadmap phase 1 core/facade split. Keeps the same
//! function names and signatures for [`crate::glob`] and [`crate::grep`];
//! only error conversion lives here.

use globset::GlobSet;
use napi::bindgen_prelude::*;
pub use pi_natives_core::glob_util::build_glob_pattern;

/// Compile a glob pattern string into a [`GlobSet`].
///
/// When `recursive` is true, simple patterns (no path separators, no leading
/// `**`) are automatically prefixed with `**/`.
pub fn compile_glob(glob: &str, recursive: bool) -> Result<GlobSet> {
	pi_natives_core::glob_util::compile_glob(glob, recursive).map_err(Error::from_reason)
}

/// Like [`compile_glob`], but accepts an `Option<&str>` — returns `Ok(None)`
/// when the input is `None`, empty, or whitespace-only.
pub fn try_compile_glob(glob: Option<&str>, recursive: bool) -> Result<Option<GlobSet>> {
	pi_natives_core::glob_util::try_compile_glob(glob, recursive).map_err(Error::from_reason)
}
