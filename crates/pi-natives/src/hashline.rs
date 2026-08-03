//! NAPI facade over [`pi_natives_core::hashline`].
//!
//! Moved there in the roadmap phase 1 core/facade split. Only the
//! `JsString`/`Utf16String` interop lives here; the export name and
//! signature are unchanged.

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

fn build_utf16_string(data: Vec<u16>) -> Utf16String {
	// We construct `data` ourselves and never append a NUL terminator, so any
	// trailing U+0000 here is legitimate JS string content and must be kept.
	// SAFETY: napi-rs represents Utf16String as a Vec<u16> newtype.
	unsafe { std::mem::transmute(data) }
}

#[napi]
pub fn h06_format_hash_lines(text: JsString, start_line: Option<u32>) -> Result<Utf16String> {
	let text_u16 = text.into_utf16()?;
	let mut text = text_u16.as_slice();
	// napi-rs `into_utf16()` exposes `utf16_len() + 1` units with one synthetic
	// trailing NUL. Strip exactly that one terminator; a legitimate trailing
	// U+0000 in the JS string is preserved (matches TS, which hashes/displays it).
	if text.last() == Some(&0) {
		text = &text[..text.len() - 1];
	}
	let out = pi_natives_core::hashline::format_hash_lines_utf16(text, start_line.unwrap_or(1));
	Ok(build_utf16_string(out))
}
