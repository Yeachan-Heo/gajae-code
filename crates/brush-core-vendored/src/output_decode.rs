// Vendored from
// can1357/oh-my-pi@a85bd5228d9f0f619deade1db78fa49420a721e1:crates/pi-shell/
// src/output_decode.rs — MIT (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026
// Stencil Labs, Inc. Modified for gajae-code: yes, shared by shell output and
// builtin line input.
//! Decode UTF-8 and Windows ACP byte streams into Unicode.
//!
//! Modern tools emit UTF-8 (Python with `PYTHONUTF8`, Node, Rust). Native
//! Windows programs on a CJK system write the ANSI code page to pipes — CP936
//! (GBK) on Simplified Chinese — and treating those bytes as UTF-8 replaces
//! them with U+FFFD (乱码).
//!
//! Policy: decode as UTF-8 until a complete invalid sequence; on Windows,
//! switch the remainder of that stream to the process ANSI code page
//! (`GetACP`) unless that page is already UTF-8.
//!
//! Valid UTF-8 always wins, including bytes that are also valid ACP (GBK 一 is
//! `D2 BB`, which is U+04BB in UTF-8). Overlap is ambiguous; this prefers the
//! modern-tool default over guessing language. The ACP switch is permanent
//! for the stream: command output is one encoding, not mixed. A single
//! invalid byte therefore ACP-decodes everything after it.

use std::str;

/// UTF-8 console / system code page. Fallback is a no-op: invalid UTF-8 stays
/// replacement characters rather than being re-decoded as itself.
#[cfg(windows)]
const CP_UTF8: u32 = 65001;
#[cfg(windows)]
const CP_GB18030: u32 = 54936;


#[derive(Clone, Copy)]
enum Mode {
	Utf8,
	#[cfg(windows)]
	Acp,
}

/// Encoding decision retained for one input stream.
#[derive(Clone, Copy)]
pub struct OutputDecoderState {
	mode: Mode,
	#[cfg(windows)]
	fallback_codepage: u32,
}

impl Default for OutputDecoderState {
	fn default() -> Self {
		Self::new()
	}
}

impl OutputDecoderState {
	/// Start with UTF-8 preference and the host ACP fallback.
	#[cfg(windows)]
	pub fn new() -> Self {
		Self::with_fallback_codepage(acp())
	}

	/// Start with UTF-8-only decoding off Windows.
	#[cfg(not(windows))]
	pub const fn new() -> Self {
		Self { mode: Mode::Utf8 }
	}

	/// Use an explicit ACP, primarily for deterministic code-page tests.
	#[cfg(windows)]
	pub const fn with_fallback_codepage(codepage: u32) -> Self {
		Self { mode: Mode::Utf8, fallback_codepage: codepage }
	}

	/// Whether a prior byte selected the ACP fallback for this stream.
	pub const fn uses_acp(&self) -> bool {
		#[cfg(windows)]
		{
			matches!(self.mode, Mode::Acp)
		}
		#[cfg(not(windows))]
		{
			false
		}
	}

	/// Select ACP fallback after invalid UTF-8, if an ACP fallback is available.
	pub fn select_acp_fallback(&mut self) -> bool {
		#[cfg(windows)]
		{
			if self.fallback_codepage != 0 && self.fallback_codepage != CP_UTF8 {
				self.mode = Mode::Acp;
				return true;
			}
		}
		false
	}

	/// The next character length after ACP fallback, or `None` if more bytes are
	/// needed to decide an incomplete sequence.
	pub fn acp_character_len(&self, bytes: &[u8], eof: bool) -> Option<usize> {
		#[cfg(windows)]
		{
			acp_character_len(self.fallback_codepage, bytes, eof)
		}
		#[cfg(not(windows))]
		{
			let _ = eof;
			Some(bytes.len().min(1))
		}
	}
}

/// Incremental decoder for one byte stream.
pub struct OutputDecoder {
	pending: Vec<u8>,
	state:   OutputDecoderState,
}

impl Default for OutputDecoder {
	fn default() -> Self {
		Self::new()
	}
}

impl OutputDecoder {
	/// Decode with the host ANSI code page as the Windows fallback.
	/// Not `const`: `GetACP` is an FFI call.
	#[cfg(windows)]
	pub fn new() -> Self {
		Self::with_state(OutputDecoderState::new())
	}

	/// Decode as UTF-8 only; no ANSI fallback exists off Windows.
	#[cfg(not(windows))]
	pub const fn new() -> Self {
		Self::with_state(OutputDecoderState::new())
	}

	/// Decode with an explicit ANSI fallback. Used by tests so GBK fixtures
	/// run on any Windows host, not only a Chinese ACP.
	#[cfg(windows)]
	pub const fn with_fallback_codepage(codepage: u32) -> Self {
		Self::with_state(OutputDecoderState::with_fallback_codepage(codepage))
	}

	/// Continue a stream using its retained UTF-8/ACP selection.
	pub const fn with_state(state: OutputDecoderState) -> Self {
		Self { pending: Vec::new(), state }
	}

	/// Current stream encoding decision.
	pub const fn state(&self) -> OutputDecoderState {
		self.state
	}

	/// Push the next bytes. Returns text that is safe to emit now;
	/// incomplete UTF-8 / DBCS sequences stay buffered.
	pub fn push(&mut self, bytes: &[u8]) -> String {
		if bytes.is_empty() {
			return String::new();
		}
		self.pending.extend_from_slice(bytes);
		self.drain(false)
	}

	/// Flush held bytes at EOF.
	pub fn finish(&mut self) -> String {
		self.drain(true)
	}

	fn drain(&mut self, eof: bool) -> String {
		match self.state.mode {
			Mode::Utf8 => self.drain_utf8(eof),
			#[cfg(windows)]
			Mode::Acp => self.drain_acp(eof),
		}
	}

	fn drain_utf8(&mut self, eof: bool) -> String {
		let mut out = String::new();
		if self.pending.is_empty() {
			return out;
		}

		loop {
			match str::from_utf8(&self.pending) {
				Ok(text) => {
					out.push_str(text);
					self.pending.clear();
					return out;
				},
				Err(error) => {
					let valid_up_to = error.valid_up_to();
					let error_len = error.error_len();
					if valid_up_to > 0 {
						// SAFETY: [..valid_up_to] is valid UTF-8 by valid_up_to().
						out.push_str(unsafe { str::from_utf8_unchecked(&self.pending[..valid_up_to]) });
					}

					if error_len.is_none() && !eof {
						self.pending.drain(..valid_up_to);
						return out;
					}

					#[cfg(windows)]
					if self.state.select_acp_fallback() {
						// One encoding per command. Do not resume UTF-8 after
						// a bad byte: later UTF-8 would be ACP-mojibake, but
						// cmd/chcp emit ACP for the whole stream.
						self.pending.drain(..valid_up_to);
						out.push_str(&self.drain_acp(eof));
						return out;
					}

					// Decode only the error bytes themselves as lossy; keep trailing incomplete
					// UTF-8 for the next chunk (unless EOF).
					let error_end = valid_up_to + error_len.unwrap_or(0);
					if error_end > valid_up_to {
						out.push_str(&String::from_utf8_lossy(&self.pending[valid_up_to..error_end]));
					}
					if eof {
						// At EOF, lossy-decode any remaining incomplete sequence.
						if error_end < self.pending.len() {
							out.push_str(&String::from_utf8_lossy(&self.pending[error_end..]));
						}
						self.pending.clear();
						return out;
					} else {
						// Not EOF: keep incomplete sequence for next chunk.
						self.pending.drain(..error_end);
						// Loop to process any remaining malformed bytes in pending.
						if self.pending.is_empty() {
							return out;
						}
					}
				},
			}
		}
	}

	#[cfg(windows)]
	fn drain_acp(&mut self, eof: bool) -> String {
		if self.pending.is_empty() {
			return String::new();
		}
		let len = complete_acp_len(self.state.fallback_codepage, &self.pending, eof);
		if len == 0 {
			return String::new();
		}
		let decoded = decode_codepage(self.state.fallback_codepage, &self.pending[..len])
			.unwrap_or_else(|| String::from_utf8_lossy(&self.pending[..len]).into_owned());
		self.pending.drain(..len);
		decoded
	}
}

/// Decode a complete buffer with the same UTF-8-then-ACP policy as
/// [`OutputDecoder`].
pub fn decode_bytes(bytes: &[u8]) -> String {
	let mut decoder = OutputDecoder::new();
	let mut out = decoder.push(bytes);
	out.push_str(&decoder.finish());
	out
}

/// Decode an owned complete buffer without copying it into the decoder.
pub fn decode_owned_bytes(bytes: Vec<u8>) -> String {
	let mut decoder = OutputDecoder::new();
	decoder.pending = bytes;
	decoder.drain(true)
}

/// Decode a complete buffer and retain any ACP selection for later buffers
/// from the same input stream.
pub fn decode_owned_bytes_with_state(
	bytes: Vec<u8>,
	state: &mut OutputDecoderState,
) -> String {
	let mut decoder = OutputDecoder::with_state(*state);
	decoder.pending = bytes;
	let decoded = decoder.drain(true);
	*state = decoder.state();
	decoded
}

#[cfg(windows)]
fn acp() -> u32 {
	// SAFETY: GetACP has no preconditions.
	unsafe { windows_sys::Win32::Globalization::GetACP() }
}

#[cfg(windows)]
fn is_dbcs_lead(codepage: u32, byte: u8) -> bool {
	// SAFETY: `IsDBCSLeadByteEx` accepts any code-page id; unknown pages return
	// false.
	unsafe { windows_sys::Win32::Globalization::IsDBCSLeadByteEx(codepage, byte) != 0 }
}

#[cfg(any(windows, test))]
fn gb18030_character_len(bytes: &[u8], eof: bool) -> Option<usize> {
	let Some(&first) = bytes.first() else {
		return Some(0);
	};
	if !matches!(first, 0x81..=0xfe) {
		return Some(1);
	}

	let Some(&second) = bytes.get(1) else {
		return if eof { Some(1) } else { None };
	};
	if matches!(second, 0x30..=0x39) {
		let Some(&third) = bytes.get(2) else {
			return if eof { Some(1) } else { None };
		};
		if !matches!(third, 0x81..=0xfe) {
			return Some(1);
		}
		let Some(&fourth) = bytes.get(3) else {
			return if eof { Some(1) } else { None };
		};
		return Some(if matches!(fourth, 0x30..=0x39) { 4 } else { 1 });
	}

	Some(if matches!(second, 0x40..=0x7e | 0x80..=0xfe) { 2 } else { 1 })
}

#[cfg(windows)]
fn is_valid_codepage_character(codepage: u32, bytes: &[u8]) -> bool {
	let Ok(len) = i32::try_from(bytes.len()) else {
		return false;
	};
	// SAFETY: `bytes` is valid for `len` bytes; a null output with zero capacity
	// is the documented size-query form. Strict validation rejects invalid DBCS
	// lead/trail pairs instead of treating every byte after a lead as its trail.
	unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			windows_sys::Win32::Globalization::MB_ERR_INVALID_CHARS,
			bytes.as_ptr(),
			len,
			std::ptr::null_mut(),
			0,
		) > 0
	}
}

#[cfg(windows)]
fn acp_character_len(codepage: u32, bytes: &[u8], eof: bool) -> Option<usize> {
	let Some(&first) = bytes.first() else {
		return Some(0);
	};
	let char_len = if codepage == CP_GB18030 {
		gb18030_character_len(bytes, eof)?
	} else if is_dbcs_lead(codepage, first) {
		if bytes.len() > 1 {
			2
		} else if eof {
			1
		} else {
			return None;
		}
	} else {
		1
	};
	if char_len > 1 && !is_valid_codepage_character(codepage, &bytes[..char_len]) {
		Some(1)
	} else {
		Some(char_len)
	}
}

/// Bytes at the start of `bytes` that form complete ACP characters.
///
/// A trail byte in GBK/Shift-JIS can itself be a lead-byte value, and GB18030
/// has four-byte sequences, so walk from the start of the ACP segment.
#[cfg(windows)]
fn complete_acp_len(codepage: u32, bytes: &[u8], eof: bool) -> usize {
	let mut index = 0;
	while index < bytes.len() {
		let Some(char_len) = acp_character_len(codepage, &bytes[index..], eof) else {
			break;
		};
		index += char_len;
	}
	index
}

#[cfg(windows)]
fn decode_codepage(codepage: u32, bytes: &[u8]) -> Option<String> {
	if bytes.is_empty() {
		return Some(String::new());
	}
	let len = i32::try_from(bytes.len()).ok()?;
	// SAFETY: `bytes` is a valid slice of `len` bytes; a null wide-char buffer
	// with cchWideChar=0 is the documented size-query form.
	let needed = unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			0,
			bytes.as_ptr(),
			len,
			std::ptr::null_mut(),
			0,
		)
	};
	if needed <= 0 {
		return None;
	}
	let mut wide = vec![0u16; needed as usize];
	// SAFETY: `wide` has `needed` UTF-16 units, matching the size query.
	let written = unsafe {
		windows_sys::Win32::Globalization::MultiByteToWideChar(
			codepage,
			0,
			bytes.as_ptr(),
			len,
			wide.as_mut_ptr(),
			needed,
		)
	};
	if written <= 0 {
		return None;
	}
	Some(String::from_utf16_lossy(&wide[..written as usize]))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn gb18030_four_byte_sequence_is_held_until_complete() {
		assert_eq!(gb18030_character_len(&[0x90], false), None);
		assert_eq!(gb18030_character_len(&[0x90, 0x30], false), None);
		assert_eq!(gb18030_character_len(&[0x90, 0x30, 0x81], false), None);
		assert_eq!(gb18030_character_len(&[0x90, 0x30, 0x81, 0x30], false), Some(4));
		assert_eq!(gb18030_character_len(&[0x90, 0x30, 0x81, 0x30], true), Some(4));
		assert_eq!(gb18030_character_len(&[0x81, 0x40], false), Some(2));
		assert_eq!(gb18030_character_len(&[0x81, 0x20], false), Some(1));
	}

	#[cfg(windows)]
	#[test]
	fn cp932_invalid_trail_is_not_counted_as_part_of_a_character() {
		assert_eq!(acp_character_len(932, &[0x81], false), None);
		assert_eq!(acp_character_len(932, &[0x81, 0x20], false), Some(1));
		assert_eq!(acp_character_len(932, &[0x81, 0x40], false), Some(2));
	}

	#[test]
	fn utf8_passthrough() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push("hello 中文\n".as_bytes()), "hello 中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_is_held_then_flushed() {
		let mut decoder = OutputDecoder::new();
		// First byte of UTF-8 中 (E4 B8 AD).
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.push(&[0xb8, 0xad]), "中");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_at_eof_becomes_replacement() {
		// Pin UTF-8-only decoding: on Windows `new()` falls back to the host ACP,
		// where a trailing 0xE4 legitimately decodes (e.g. `ä` under cp1252).
		#[cfg(windows)]
		let mut decoder = OutputDecoder::with_fallback_codepage(CP_UTF8);
		#[cfg(not(windows))]
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.finish(), "\u{FFFD}");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_decodes_to_chinese() {
		// GBK for 中文.
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn host_acp_decodes_gbk_when_system_is_936() {
		if acp() != 936 {
			return;
		}
		assert_eq!(decode_bytes(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_character_split_across_reads() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(&[0xd6]), "");
		assert_eq!(decoder.push(&[0xd0, 0xce, 0xc4, b'\n']), "中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn gb18030_four_byte_character_split_across_reads() {
		let mut decoder = OutputDecoder::with_fallback_codepage(CP_GB18030);
		// GB18030 for U+10000.
		assert_eq!(decoder.push(&[0x90, 0x30]), "");
		assert_eq!(decoder.push(&[0x81, 0x30]), "𐀀");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn cp932_invalid_trail_decodes_before_the_following_ascii_character() {
		let mut decoder = OutputDecoder::with_fallback_codepage(932);
		assert_eq!(decoder.push(&[0x81, 0x20]), "\u{FFFD} ");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_holds_real_lead_not_trail_that_looks_like_lead() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		// 文 is CE C4; C4 is also a GBK lead value, so a last-byte heuristic
		// would hold it back and mangle 文.
		assert_eq!(decoder.push(&[0xce, 0xc4]), "文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn ascii_prefix_then_gbk() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(b"cmd"), "cmd");
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn utf8_preferred_over_gbk_fallback() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push("中文".as_bytes()), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn incomplete_utf8_at_eof_falls_back_to_acp() {
		// CP1252 for é is also an incomplete three-byte UTF-8 prefix. EOF proves
		// this stream is not valid UTF-8, so it must still trigger fallback.
		let mut decoder = OutputDecoder::with_fallback_codepage(1252);
		assert_eq!(decoder.push(&[0xe9]), "");
		assert_eq!(decoder.finish(), "é");
	}

	#[cfg(windows)]
	#[test]
	fn cp1252_external_line_decodes_with_its_newline() {
		let mut decoder = OutputDecoder::with_fallback_codepage(1252);
		assert_eq!(decoder.push(&[0xe9, b'\n']), "é\n");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn utf8_system_codepage_keeps_replacement() {
		let mut decoder = OutputDecoder::with_fallback_codepage(65001);
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(not(windows))]
	#[test]
	fn invalid_utf8_becomes_replacement() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn malformed_byte_keeps_incomplete_utf8_suffix() {
		// 0xff is an invalid byte, 0xe2 is the start of a 3-byte UTF-8 sequence (€).
		// Should return replacement for 0xff but keep 0xe2 for the next chunk.
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xff, 0xe2]), "\u{FFFD}");
		// Next chunk completes the € character (0xE2 0x82 0xAC).
		assert_eq!(decoder.push(&[0x82, 0xac]), "€");
		assert_eq!(decoder.finish(), "");
	}
}
