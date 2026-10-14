// Vendored from can1357/oh-my-pi@68fb9863b377af566d3b56aa882a964654b5760a:crates/pi-builtins/src/line_input.rs — MIT (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Modified for gajae-code: yes, block read-ahead and its seek-back removed: input is read one byte at a time and never seeked, and bytes a reader takes back are held with the open file description for its next reader.
//! Byte input for the line-reading builtins (`read`, `mapfile`).

use std::io::{self, Read};

use brush_core::{
	openfiles::OpenFile,
	output_decode::{
		OutputDecoderState, decode_owned_bytes, decode_owned_bytes_with_state,
	},
};

/// ASCII control character for Ctrl+C (ETX - End of Text).
pub(crate) const CTRL_C: u8 = 0x03;
/// ASCII control character for Ctrl+D (EOT - End of Transmission).
pub(crate) const CTRL_D: u8 = 0x04;

/// A shell descriptor read one byte at a time by its caller.
///
/// Every byte is its own OS read, so a builtin takes only what it consumes
/// and never seeks: another reader of the descriptor (an external command,
/// a `mapfile -C` callback, a background job) resumes right after the last
/// byte handed out. Bytes taken back are held with the open file
/// description, and its next builtin reader gets them first.
pub(crate) struct LineInput {
	input: OpenFile,
}

impl LineInput {
	pub(crate) const fn new(input: OpenFile) -> Self {
		Self { input }
	}

	/// The underlying descriptor, e.g. to poll it before a read that could
	/// block.
	pub(crate) const fn input(&self) -> &OpenFile {
		&self.input
	}

	/// Whether input is held for the next read, without taking it.
	pub(crate) fn has_held(&self) -> bool {
		self.input.held_input().is_some_and(|held| !held.is_empty())
	}

	/// Takes the first held byte, if any, in one step, so a concurrent
	/// reader of the description cannot take the same byte.
	pub(crate) fn take_held(&self) -> Option<u8> {
		self.input.held_input().and_then(|held| held.pop())
	}

	/// One byte from the descriptor, or `None` at end of input. Never looks
	/// at held input.
	pub(crate) fn read_byte(&mut self) -> io::Result<Option<u8>> {
		let mut byte = [0_u8; 1];
		Ok((self.input.read(&mut byte)? == 1).then_some(byte[0]))
	}

	/// The next byte, held input first, or `None` at end of input.
	pub(crate) fn next_byte(&mut self) -> io::Result<Option<u8>> {
		match self.take_held() {
			Some(byte) => Ok(Some(byte)),
			None => self.read_byte(),
		}
	}

	/// Holds `bytes` ahead of any held input, so the next builtin read of
	/// the description gets them first. A write-only descriptor has no
	/// store; its reads fail before anything could be taken back.
	pub(crate) fn unread(&self, bytes: &[u8]) {
		if let Some(held) = self.input.held_input() {
			held.put_back(bytes);
		}
	}

	/// Decoder selection shared by every builtin reader of this input.
	pub(crate) fn decoder_state(&self) -> OutputDecoderState {
		self.input
			.held_input()
			.map_or_else(OutputDecoderState::default, |held| held.output_decoder_state())
	}

	/// Retains a decoder selection made while counting a partial input line.
	pub(crate) fn set_decoder_state(&self, state: OutputDecoderState) {
		if let Some(held) = self.input.held_input() {
			held.set_output_decoder_state(state);
		}
	}

	/// Decodes a complete line and saves any ACP selection for the next line.
	pub(crate) fn decode_line(&self, line: Vec<u8>) -> String {
		let Some(held) = self.input.held_input() else {
			return decode_owned_bytes(line);
		};
		let mut state = held.output_decoder_state();
		let decoded = decode_owned_bytes_with_state(line, &mut state);
		self.set_decoder_state(state);
		decoded
	}

	/// Finalizes bytes consumed before a `read -t` timeout into its partial
	/// result. The timeout ends this line, so incomplete characters cannot be
	/// deferred in held input where native readers would not see them.
	pub(crate) fn decode_bytes_on_timeout(&self, line: Vec<u8>) -> String {
		let mut state = self.decoder_state();
		let decoded = decode_owned_bytes_with_state(line, &mut state);
		self.set_decoder_state(state);
		decoded
	}
}

#[cfg(test)]
#[expect(clippy::panic_in_result_fn)]
mod tests {
	use std::io::{Seek, Write};

	use anyhow::Result;

	use super::*;

	/// A file holding `contents`, already unlinked, and a std duplicate of
	/// it that shares its offset.
	fn file_with(name: &str, contents: &[u8]) -> Result<(std::fs::File, std::fs::File)> {
		let path =
			std::env::temp_dir().join(format!("brush-line-input-{name}-{}.txt", std::process::id()));
		std::fs::write(&path, contents)?;
		let file = std::fs::File::open(&path)?;
		let other = file.try_clone()?;
		std::fs::remove_file(&path)?;
		Ok((file, other))
	}

	/// Regression: a reader takes only the bytes it hands out, so another
	/// reader of the same open file resumes right after them while the input
	/// is still in use, and nothing is rewound when it goes away.
	#[test]
	fn a_reader_takes_only_the_bytes_it_hands_out() -> Result<()> {
		let (file, mut other) = file_with("takes-only", b"abcd")?;

		let mut input = LineInput::new(OpenFile::from(file));
		assert_eq!(input.next_byte()?, Some(b'a'));
		let mut middle = [0_u8; 2];
		std::io::Read::read_exact(&mut other, &mut middle)?;
		assert_eq!(&middle, b"bc");
		assert_eq!(input.next_byte()?, Some(b'd'));
		drop(input);
		assert_eq!(other.stream_position()?, 4);
		Ok(())
	}

	/// Contract: bytes taken back from a regular file are held for the next
	/// reader of the open file; the shared offset is not seeked back.
	#[test]
	fn bytes_taken_back_from_a_file_are_held_not_seeked() -> Result<()> {
		let (file, mut offset) = file_with("held-not-seeked", b"abc")?;
		let file = OpenFile::from(file);

		let mut input = LineInput::new(file.try_clone()?);
		assert_eq!(input.next_byte()?, Some(b'a'));
		assert_eq!(input.next_byte()?, Some(b'b'));
		input.unread(b"b");
		drop(input);
		assert_eq!(offset.stream_position()?, 2);

		let mut input = LineInput::new(file);
		assert_eq!(input.next_byte()?, Some(b'b'));
		assert_eq!(input.next_byte()?, Some(b'c'));
		assert_eq!(input.next_byte()?, None);
		Ok(())
	}

	/// Contract: bytes taken back from a pipe are held for the next reader,
	/// in the same input and in a later one of the same pipe.
	#[test]
	fn bytes_taken_back_from_a_pipe_are_held_for_the_next_reader() -> Result<()> {
		let (reader, mut writer) = std::io::pipe()?;
		writer.write_all(b"abc")?;
		drop(writer);
		let pipe = OpenFile::from(reader);

		let mut input = LineInput::new(pipe.try_clone()?);
		assert_eq!(input.next_byte()?, Some(b'a'));
		assert_eq!(input.next_byte()?, Some(b'b'));
		input.unread(b"b");
		assert_eq!(input.next_byte()?, Some(b'b'));
		input.unread(b"b");
		drop(input);

		let mut input = LineInput::new(pipe);
		assert_eq!(input.next_byte()?, Some(b'b'));
		assert_eq!(input.next_byte()?, Some(b'c'));
		assert_eq!(input.next_byte()?, None);
		Ok(())
	}

	/// Contract: bytes held later come first, each batch in input order,
	/// and the descriptor is read once held input runs out.
	#[test]
	fn held_input_comes_first_in_input_order() -> Result<()> {
		let (reader, mut writer) = std::io::pipe()?;
		writer.write_all(b"d")?;
		drop(writer);
		let mut input = LineInput::new(OpenFile::from(reader));
		input.unread(b"c");
		input.unread(b"ab");
		for expected in [Some(b'a'), Some(b'b'), Some(b'c'), Some(b'd'), None] {
			assert_eq!(input.next_byte()?, expected);
		}
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	fn decoder_selection_is_shared_by_cloned_input_readers() -> Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input");
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(936));

		let first = LineInput::new(input.try_clone()?);
		let _ = first.decode_line(vec![0xff]);
		assert!(held.output_decoder_state().uses_acp());

		let second = LineInput::new(input);
		assert_eq!(second.decode_line(vec![0xd2, 0xbb]), "一");
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	fn timeout_decode_uses_shared_acp_selection() -> Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input").clone();
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(936));

		let first = LineInput::new(input.try_clone()?);
		let _ = first.decode_line(vec![0xff]);
		assert!(held.output_decoder_state().uses_acp());

		let timed_out = LineInput::new(input);
		assert_eq!(timed_out.decode_bytes_on_timeout(vec![0xd2, 0xbb]), "一");
		assert!(held.output_decoder_state().uses_acp());
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	fn timeout_decode_finalizes_incomplete_acp_bytes_and_selection() -> Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input").clone();
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(936));

		let timed_out = LineInput::new(input);
		let partial = timed_out.decode_bytes_on_timeout(vec![0xff, 0xd2]);
		assert!(!partial.is_empty());
		assert!(held.output_decoder_state().uses_acp());
		assert!(held.is_empty());
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	fn timeout_decode_persists_acp_fallback_for_the_stream() -> Result<()> {
		// ACP selection applies to the whole stream, including bytes received
		// after a timed-out read.
		let (reader, _writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds decoder state").clone();
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(1252));

		let timed_out = LineInput::new(input.try_clone()?);
		assert_eq!(timed_out.decode_bytes_on_timeout(vec![0x80]), "€");
		assert!(timed_out.decoder_state().uses_acp());

		// These bytes are valid UTF-8 as £ but are CP1252 "Â£" once this
		// stream has selected its ACP fallback.
		let next_read = LineInput::new(input);
		assert_eq!(next_read.decode_line(vec![0xc2, 0xa3]), "Â£");
		Ok(())
	}
}
