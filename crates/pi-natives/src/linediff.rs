//! NAPI facade over [`pi_natives_core::linediff`].
//!
//! Moved there in the roadmap phase 1 core/facade split. The jsdiff-parity
//! algorithm lives in the core crate; this file re-wraps the parts into the
//! NAPI object shape with the same export name and signature.

use napi_derive::napi;

/// One diff component, mirroring jsdiff's change object (sans `count`, which
/// the TS `generateDiffString` formatter does not consume).
#[napi(object)]
pub struct LineDiffPart {
	pub added:   bool,
	pub removed: bool,
	pub value:   String,
}

/// Compute a line-level diff byte-identical to jsdiff `Diff.diffLines(old,
/// new)` with default options. Returns ordered `{added, removed, value}` parts.
#[napi]
pub fn diff_lines(old_str: String, new_str: String) -> Vec<LineDiffPart> {
	pi_natives_core::linediff::diff_lines(old_str, new_str)
		.into_iter()
		.map(|part| LineDiffPart { added: part.added, removed: part.removed, value: part.value })
		.collect()
}
