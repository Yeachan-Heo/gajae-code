pub(crate) use brush_core::output_decode::{OutputDecoder, decode_bytes};

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn utf8_passthrough() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push("hello 中文\n".as_bytes()), "hello 中文\n");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn incomplete_utf8_is_held_then_flushed() {
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xe4]), "");
		assert_eq!(decoder.push(&[0xb8, 0xad]), "中");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn invalid_utf8_becomes_replacement() {
		#[cfg(windows)]
		let mut decoder = OutputDecoder::with_fallback_codepage(65001);
		#[cfg(not(windows))]
		let mut decoder = OutputDecoder::new();
		assert_eq!(decoder.push(&[0xff]), "\u{FFFD}");
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn large_malformed_input_preserves_each_replacement() {
		const INVALID_BYTES: usize = 64 * 1024;

		#[cfg(windows)]
		let mut decoder = OutputDecoder::with_fallback_codepage(65001);
		#[cfg(not(windows))]
		let mut decoder = OutputDecoder::new();

		let input = vec![0xff; INVALID_BYTES];
		let decoded = decoder.push(&input);
		assert_eq!(decoded, "\u{FFFD}".repeat(INVALID_BYTES));
		assert_eq!(decoder.finish(), "");
	}

	#[test]
	fn complete_utf8_buffer_decodes() {
		assert_eq!(decode_bytes("hello 中文".as_bytes()), "hello 中文");
	}

	#[cfg(windows)]
	#[test]
	fn gbk_decodes_to_chinese() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push(&[0xd6, 0xd0, 0xce, 0xc4]), "中文");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn cp1252_native_line_decodes_with_newline() {
		let mut decoder = OutputDecoder::with_fallback_codepage(1252);
		assert_eq!(decoder.push(&[0xe9, b'\n']), "é\n");
		assert_eq!(decoder.finish(), "");
	}

	#[cfg(windows)]
	#[test]
	fn utf8_is_preferred_over_gbk_fallback() {
		let mut decoder = OutputDecoder::with_fallback_codepage(936);
		assert_eq!(decoder.push("中文".as_bytes()), "中文");
		assert_eq!(decoder.finish(), "");
	}
}
