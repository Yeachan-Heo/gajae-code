// Vendored from can1357/oh-my-pi@68fb9863b377af566d3b56aa882a964654b5760a:crates/pi-builtins/src/read.rs — MIT (c) 2025 Mario Zechner, 2025-2026 Can Bölük, 2026 Stencil Labs, Inc. Modified for gajae-code: yes, preserves cancellation, timeout, and readiness guards; reads one byte at a time with no read-ahead, taking held input before polling a stream for every other byte; counts -n/-N characters as the line decodes, counting an incomplete character at EOF, and holds the input read past the limit with the open file description for the next read.
use std::{
	collections::VecDeque,
	io::Write,
	sync::MutexGuard,
	time::{Duration, Instant},
};

use brush_core::{
	ErrorKind,
	builtins,
	env,
	error,
	openfiles::{HeldInput, OpenFile},
	output_decode::OutputDecoderState,
	variables,
};
use clap::Parser;
use itertools::Itertools;

use crate::line_input::{CTRL_C, CTRL_D, LineInput};

/// Exit code returned when `read` times out.
/// This is 128 + SIGALRM (14) = 142, matching bash behavior.
const TIMEOUT_EXIT_CODE: u8 = 142;

/// Backslash character used for escape processing.
const BACKSLASH: u8 = b'\\';
/// Default line delimiter (newline).
const DEFAULT_DELIMITER: u8 = b'\n';
/// NUL character used as delimiter when `-d ''` is specified.
const NUL_DELIMITER: u8 = b'\0';

/// Parse standard input.
#[derive(Parser)]
pub(crate) struct ReadCommand {
	/// Optionally, name of an array variable to receive read words
	/// of input.
	#[clap(short = 'a', value_name = "VAR_NAME")]
	array_variable: Option<String>,

	/// Optionally, a delimiter to use other than a newline character.
	#[clap(short = 'd')]
	delimiter: Option<String>,

	/// Use readline-like input.
	#[clap(short = 'e')]
	use_readline: bool,

	/// Provide text to use as initial input for readline.
	#[clap(short = 'i', value_name = "STR")]
	initial_text: Option<String>,

	/// Read only the first N characters or until a specified
	/// delimiter is reached, whichever happens first.
	#[clap(short = 'n', value_name = "COUNT")]
	return_after_n_chars: Option<usize>,

	/// Read exactly N characters, ignoring any specified delimiter.
	#[clap(short = 'N', value_name = "COUNT")]
	return_after_n_chars_no_delimiter: Option<usize>,

	/// Prompt to display before reading.
	#[clap(short = 'p')]
	prompt: Option<String>,

	/// Read input in raw mode; no escape sequences.
	#[clap(short = 'r')]
	raw_mode: bool,

	/// Do not echo input.
	#[clap(short = 's')]
	silent: bool,

	/// Specify timeout in seconds; fail if the timeout elapses before
	/// input is completed.
	#[clap(short = 't', value_name = "SECONDS", allow_hyphen_values = true)]
	timeout_in_seconds: Option<f64>,

	/// File descriptor to read from instead of stdin.
	#[clap(short = 'u', name = "FD")]
	fd_num_to_read: Option<u8>,

	/// Optionally, names of variables to receive read input.
	variable_names: Vec<String>,
}

impl builtins::Command for ReadCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {

		// Validate timeout value if provided.
		if let Some(result) = self.validate_timeout(&context)? {
			return Ok(result);
		}

		// Find the input stream to use.
		let fd_num = self
			.fd_num_to_read
			.map_or(brush_core::openfiles::OpenFiles::STDIN_FD, brush_core::ShellFd::from);

		// Retrieve the file.
		let input_stream = context
			.try_fd(fd_num)
			.ok_or_else(|| ErrorKind::BadFileDescriptor(fd_num))?;
		// Readline flags are accepted for redirected input, where there is no
		// terminal line editor to activate. Initial text is only meaningful with
		// `-e`; on a terminal that combination remains unsupported.
		if self.use_readline && input_stream.is_terminal() {
			return error::unimp(if self.initial_text.is_some() {
				"read -e -i"
			} else {
				"read -e"
			});
		}

		// Retrieve effective value of IFS for splitting.
		// We convert to owned String to release the borrow before the mutable borrow
		// needed for variable assignment.
		let ifs = context.shell.ifs().into_owned();

		// Convert timeout to Duration.
		let timeout = self.timeout_in_seconds.map(Duration::from_secs_f64);

		// Perform the read operation (potentially with timeout).
		let read_result =
			self.read_line(input_stream, context.stderr(), timeout, || context.is_cancelled())?;

		// Determine whether to skip IFS splitting (for -N option).
		let skip_ifs_splitting = self.return_after_n_chars_no_delimiter.is_some();

		// Extract the input line and determine exit code based on result.
		let (input_line, result) = match &read_result {
			ReadResult::Line(line) => (Some(line.clone()), brush_core::ExecutionResult::success()),
			ReadResult::Eof(Some(line)) => {
				(Some(line.clone()), brush_core::ExecutionResult::general_error())
			},
			ReadResult::Eof(None) | ReadResult::Interrupted | ReadResult::InputNotReady => {
				(None, brush_core::ExecutionResult::general_error())
			},
			ReadResult::TimedOut(partial) => {
				(partial.clone(), brush_core::ExecutionResult::new(TIMEOUT_EXIT_CODE))
			},
			ReadResult::InputReady => (None, brush_core::ExecutionResult::success()),
		};

		// Assign input to variables based on options.
		assign_input_to_variables(
			context.shell,
			input_line.as_deref(),
			&ifs,
			skip_ifs_splitting,
			self.array_variable.as_deref(),
			&self.variable_names,
		)?;

		Ok(result)
	}
}

/// Assigns read input to shell variables based on the specified options.
///
/// This handles three modes:
/// - Array mode (`-a`): Split input by IFS and assign to array elements
/// - Named variables: Split input by IFS and assign to each variable, with
///   remainder to last
/// - Default (`REPLY`): Assign entire input line to the `REPLY` variable
fn assign_input_to_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	array_variable: Option<&str>,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	if let Some(array_variable) = array_variable {
		let literal_fields = build_array_fields(input_line, ifs, skip_ifs_splitting);
		shell.env_mut().update_or_add(
			array_variable,
			variables::ShellValueLiteral::Array(variables::ArrayLiteral(literal_fields)),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	} else if !variable_names.is_empty() {
		assign_to_named_variables(shell, input_line, ifs, skip_ifs_splitting, variable_names)?;
	} else {
		shell.env_mut().update_or_add(
			"REPLY",
			variables::ShellValueLiteral::Scalar(input_line.unwrap_or_default().to_owned()),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	}
	Ok(())
}

/// Assigns split fields to named variables.
///
/// Fields are assigned one per variable, with any remaining fields joined by
/// space and assigned to the last variable. If there are more variables than
/// fields, the extra variables are set to empty strings.
fn assign_to_named_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	let mut fields =
		build_variable_fields(input_line, ifs, skip_ifs_splitting, variable_names.len());

	for (i, name) in variable_names.iter().enumerate() {
		let is_last = i == variable_names.len() - 1;

		let value = if fields.is_empty() {
			String::new()
		} else if is_last {
			// Last variable gets all remaining fields joined by space.
			std::mem::take(&mut fields).into_iter().join(" ")
		} else {
			fields.pop_front().unwrap_or_default()
		};

		shell.env_mut().update_or_add(
			name,
			variables::ShellValueLiteral::Scalar(value),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;

		if is_last {
			break;
		}
	}
	Ok(())
}

/// Builds array field values from input, optionally splitting by IFS.
fn build_array_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
) -> Vec<(Option<String>, String)> {
	match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input as single element.
			vec![(None, line.to_string())]
		},
		Some(line) => {
			let fields: VecDeque<_> = split_line_by_ifs(ifs, line, None /* max_fields */);
			fields.into_iter().map(|f| (None, f)).collect()
		},
		None => vec![],
	}
}

/// Builds field values from input for assignment to named variables.
fn build_variable_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	num_variables: usize,
) -> VecDeque<String> {
	match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input in first variable.
			let mut fields = VecDeque::new();
			fields.push_back(line.to_string());
			fields
		},
		Some(line) => split_line_by_ifs(ifs, line, Some(num_variables)),
		None => VecDeque::new(),
	}
}

/// Result of a `read` operation.
///
/// This enum clearly represents all possible outcomes of `read_line()`,
/// making the contract with callers explicit.
#[derive(Debug)]
enum ReadResult {
	/// Successfully read a complete line (delimiter or char limit reached).
	Line(String),
	/// Reached end of input. Contains any partial content read before EOF.
	Eof(Option<String>),
	/// Input was interrupted (e.g., Ctrl+C). No content is returned.
	Interrupted,
	/// The operation timed out. Contains any partial content read before
	/// timeout.
	TimedOut(Option<String>),
	/// For `-t 0`: input is immediately available (exit 0).
	InputReady,
	/// For `-t 0`: no input immediately available (exit 1).
	InputNotReady,
}

/// Low-level input reader that handles timeouts and control characters.
///
/// This separates the concerns of byte-level I/O with timeout handling
/// from the higher-level logic of line building and escape processing.
struct InputReader {
	/// The input source, read one byte at a time; input read past a
	/// `-n`/`-N` limit is held for the next read.
	source:     LineInput,
	/// Optional deadline for timeout.
	deadline:   Option<Instant>,
	/// Terminal input: Ctrl-C and Ctrl-D bytes are keys, not data.
	terminal:   bool,
	/// Terminal mode guard - kept alive for RAII cleanup on drop.
	/// The guard restores original terminal settings when dropped, even though
	/// we don't access the field directly after construction.
	///
	/// The leading underscore suppresses the "unused field" warning while making
	/// it explicit this field exists solely for its `Drop` implementation.
	_term_mode: Option<brush_core::terminal::AutoModeGuard>,
}

/// Events that can occur when reading input.
enum InputEvent {
	/// A data byte was read.
	Byte(u8),
	/// End of file was reached.
	Eof,
	/// The read operation timed out.
	Timeout,
	/// Ctrl+C was pressed.
	CtrlC,
	/// Ctrl+D was pressed.
	CtrlD,
}

fn ensure_not_cancelled<F>(is_cancelled: &F) -> Result<(), brush_core::Error>
where
	F: Fn() -> bool,
{
	if is_cancelled() {
		return Err(ErrorKind::Interrupted.into());
	}

	Ok(())
}

fn acquire_read_lock<'a, F>(
	held_input: &'a HeldInput,
	deadline: Option<Instant>,
	is_cancelled: &F,
) -> Result<Option<MutexGuard<'a, ()>>, brush_core::Error>
where
	F: Fn() -> bool,
{
	const RETRY_INTERVAL: Duration = Duration::from_millis(10);

	loop {
		ensure_not_cancelled(is_cancelled)?;
		if let Some(guard) = held_input.try_lock_reader() {
			if deadline.is_some_and(|deadline| Instant::now() >= deadline) {
				drop(guard);
				return Ok(None);
			}
			return Ok(Some(guard));
		}

		let sleep_for = if let Some(deadline) = deadline {
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(None);
			}
			remaining.min(RETRY_INTERVAL)
		} else {
			RETRY_INTERVAL
		};
		std::thread::sleep(sleep_for);
	}
}

impl InputReader {
	/// Creates a new input reader with an absolute timeout deadline.
	fn new(
		input: OpenFile,
		deadline: Option<Instant>,
		term_mode: Option<brush_core::terminal::AutoModeGuard>,
	) -> Self {
		let terminal = input.is_terminal();
		Self {
			source: LineInput::new(input),
			deadline,
			terminal,
			_term_mode: term_mode,
		}
	}

	/// Checks if input is immediately available (for `-t 0`), held input
	/// included, without consuming it. Returns `false` if an error occurs
	/// while checking for available input.
	fn check_input_available(&self) -> bool {
		self.source.has_held()
			|| brush_core::sys::poll::poll_for_input(self.source.input(), Duration::ZERO)
				.unwrap_or(false)
	}

	#[cfg(unix)]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		const INPUT_POLL_INTERVAL_MS: u64 = 100;

		if self.deadline.is_none() && self.source.input().try_borrow_as_fd().is_err() {
			ensure_not_cancelled(is_cancelled)?;
			return Ok(None);
		}

		loop {
			ensure_not_cancelled(is_cancelled)?;

			let timeout = if let Some(deadline) = self.deadline {
				let remaining = deadline.saturating_duration_since(Instant::now());
				if remaining.is_zero() {
					return Ok(Some(InputEvent::Timeout));
				}

				remaining.min(Duration::from_millis(INPUT_POLL_INTERVAL_MS))
			} else {
				Duration::from_millis(INPUT_POLL_INTERVAL_MS)
			};

			match brush_core::sys::poll::poll_for_input(self.source.input(), timeout) {
				Ok(true) => return Ok(None),
				Ok(false) => continue,
				Err(e) => return Err(e.into()),
			}
		}
	}

	#[cfg(not(unix))]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		ensure_not_cancelled(is_cancelled)?;

		if let Some(deadline) = self.deadline {
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(Some(InputEvent::Timeout));
			}

			match brush_core::sys::poll::poll_for_input(self.source.input(), remaining) {
				Ok(true) => {},
				Ok(false) => return Ok(Some(InputEvent::Timeout)),
				Err(e) => return Err(e.into()),
			}
		}

		Ok(None)
	}

	/// The text of a `-n`/`-N` read whose limit fell before trailing bytes in
	/// `line`. Each line byte records the input bytes that produced it, so
	/// escaped bytes can be returned intact to the next read.
	fn line_before_trailing_bytes(
		&self,
		mut line: Vec<u8>,
		raw_backslashes: Vec<bool>,
		trailing_bytes: usize,
	) -> String {
		let keep = line.len().saturating_sub(trailing_bytes);
		let mut unread = Vec::with_capacity(trailing_bytes * 2);
		for (&byte, &escaped) in line.iter().zip(&raw_backslashes).skip(keep) {
			if escaped {
				unread.push(BACKSLASH);
			}
			unread.push(byte);
		}
		line.truncate(keep);
		self.source.unread(&unread);
		self.source.decode_line(line)
	}

	/// Reads the next input event, handling timeout and control characters.
	fn read_event<F>(&mut self, is_cancelled: &F) -> Result<InputEvent, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		ensure_not_cancelled(is_cancelled)?;
		if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
			return Ok(InputEvent::Timeout);
		}
		// Held input is taken by one atomic pop and never waits. Any other byte
		// is polled first: a ready count goes stale when another reader of a
		// shared pipe drains it, and the read would then block where neither
		// `-t` nor cancellation is checked. Never test for held input and then
		// read.
		let byte = if let Some(byte) = self.source.take_held() {
			byte
		} else {
			if let Some(event) = self.wait_for_input(is_cancelled)? {
				return Ok(event);
			}
			ensure_not_cancelled(is_cancelled)?;
			let Some(byte) = self.source.read_byte()? else {
				return Ok(InputEvent::Eof);
			};
			byte
		};

		// Control keys only mean something on a terminal; in a file or pipe
		// they are data.
		Ok(match byte {
			CTRL_C if self.terminal => InputEvent::CtrlC,
			CTRL_D if self.terminal => InputEvent::CtrlD,
			_ => InputEvent::Byte(byte),
		})
	}
}

/// Configuration for line reading behavior.
struct LineReaderConfig {
	/// Byte that terminates input (None for -N mode).
	delimiter:       Option<u8>,
	/// Maximum characters to read (for -n or -N).
	char_limit:      Option<usize>,
	/// Whether to process backslash escapes (false for -r mode).
	process_escapes: bool,
}

/// Characters read toward a `-n`/`-N` limit, using the same active encoding as
/// the line decoder. UTF-8 malformed sequences become one replacement
/// character; valid ACP multibyte sequences count as one character.
struct CharCount {
	chars:   usize,
	pending: [u8; 4],
	len:     usize,
	state:   OutputDecoderState,
}

enum Utf8Character {
	Valid(usize),
	Invalid(usize),
}

/// Where a byte leaves a [`CharCount`] relative to its limit.
enum Limit {
	/// Below the limit, or inside a character not yet complete.
	NotReached,
	/// Reached by the character this byte completes.
	Reached,
	/// Reached before these trailing bytes, which must be returned to input.
	Passed(usize),
}

impl CharCount {
	fn new(state: OutputDecoderState) -> Self {
		Self { chars: 0, pending: [0; 4], len: 0, state }
	}

	fn push(&mut self, byte: u8, limit: Option<usize>) -> Limit {
		self.pending[self.len] = byte;
		self.len += 1;
		if self.state.uses_acp() {
			return self.process_acp(false, limit);
		}

		while let Some(character) = self.next_utf8_character() {
			match character {
				Utf8Character::Valid(char_len) => {
					self.consume_pending(char_len);
					self.chars += 1;
				},
				Utf8Character::Invalid(char_len) => {
					if self.state.select_acp_fallback() {
						return self.process_acp(false, limit);
					}
					self.consume_pending(char_len);
					self.chars += 1;
				},
			}
			if limit.is_some_and(|limit| self.chars >= limit) {
				return self.limit_result(self.len);
			}
		}
		Limit::NotReached
	}

	/// At EOF, flush the last incomplete UTF-8 or ACP character.
	fn finish(&mut self, limit: Option<usize>) -> Limit {
		if self.len == 0 {
			return Limit::NotReached;
		}
		if !self.state.uses_acp() && self.state.select_acp_fallback() {
			return self.process_acp(true, limit);
		}
		if self.state.uses_acp() {
			return self.process_acp(true, limit);
		}
		self.len = 0;
		self.chars += 1;
		if limit.is_some_and(|limit| self.chars >= limit) {
			Limit::Reached
		} else {
			Limit::NotReached
		}
	}

	fn next_utf8_character(&self) -> Option<Utf8Character> {
		(1..=self.len).find_map(|end| match std::str::from_utf8(&self.pending[..end]) {
			Ok(_) => Some(Utf8Character::Valid(end)),
			Err(error) => error.error_len().map(Utf8Character::Invalid),
		})
	}

	fn consume_pending(&mut self, consumed: usize) {
		self.pending.copy_within(consumed..self.len, 0);
		self.len -= consumed;
	}

	fn process_acp(&mut self, eof: bool, limit: Option<usize>) -> Limit {
		let mut index = 0;
		while index < self.len {
			let Some(char_len) = self.state.acp_character_len(&self.pending[index..self.len], eof)
			else {
				break;
			};
			index += char_len;
			self.chars += 1;
			if limit.is_some_and(|limit| self.chars >= limit) {
				let trailing = self.len - index;
				self.consume_pending(index);
				return self.limit_result(trailing);
			}
		}
		self.consume_pending(index);
		Limit::NotReached
	}

	fn limit_result(&self, trailing: usize) -> Limit {
		if trailing == 0 { Limit::Reached } else { Limit::Passed(trailing) }
	}

	/// A backslash can be the trail byte of an ACP character, even before an
	/// invalid UTF-8 byte has switched this stream to ACP mode.
	fn is_acp_character_continuation(&self, byte: u8) -> bool {
		if self.len == 0 || self.len == self.pending.len() {
			return false;
		}
		let len = self.len + 1;
		let mut candidate = [0; 4];
		candidate[..self.len].copy_from_slice(&self.pending[..self.len]);
		candidate[self.len] = byte;
		matches!(
			self.state.acp_character_len(&candidate[..len], false),
			Some(character_len) if character_len == len && character_len > 1
		)
	}
}

/// Reads a complete line of input using the given reader and configuration.
///
/// Returns a `ReadResult` indicating success, EOF, timeout, or interruption.
///
/// Note on character counting for `-n` limit:
/// Bash counts OUTPUT characters (after escape processing) toward the limit.
/// For example, with `-n 3` and input `a\bc` (4 bytes):
/// - Bash processes: 'a' (output 1), '\b' → 'b' (output 2), 'c' (output 3) →
///   "abc"
/// - The backslash is consumed but doesn't count toward the limit
fn read_line_with_reader<F>(
	reader: &mut InputReader,
	config: &LineReaderConfig,
	is_cancelled: &F,
) -> Result<ReadResult, brush_core::Error>
where
	F: Fn() -> bool,
{
	let mut line = Vec::new();
	let mut raw_backslashes = Vec::new();
	let mut count = CharCount::new(reader.source.decoder_state());
	let mut pending_backslash = false;

	loop {
		let event = match reader.read_event(is_cancelled) {
			Ok(event) => event,
			Err(error) => {
				// Bytes already consumed may have selected ACP for this stream.
				reader.source.set_decoder_state(count.state);
				return Err(error);
			},
		};

		match event {
			InputEvent::Eof => {
				match count.finish(config.char_limit) {
					Limit::Reached => return Ok(ReadResult::Line(reader.source.decode_line(line))),
					Limit::Passed(past) => {
						return Ok(ReadResult::Line(
							reader.line_before_trailing_bytes(line, raw_backslashes, past),
						));
					},
					Limit::NotReached => {},
				}
				// Bash discards pending backslash on EOF.
				return Ok(ReadResult::Eof(
					(!line.is_empty()).then(|| reader.source.decode_line(line)),
				));
			},

			InputEvent::Timeout => {
				// Include pending backslash on timeout (different from EOF).
				if pending_backslash {
					line.push(BACKSLASH);
					raw_backslashes.push(false);
				}
				// Finalize consumed bytes into the partial value. The read has
				// returned, so an incomplete character cannot remain pending for
				// a later builtin-only read.
				return Ok(ReadResult::TimedOut(
					(!line.is_empty()).then(|| reader.source.decode_bytes_on_timeout(line)),
				));
			},

			InputEvent::CtrlC => {
				reader.source.set_decoder_state(count.state);
				return Ok(ReadResult::Interrupted);
			},

			InputEvent::CtrlD => {
				// At line start = EOF, mid-input = flush current input.
				// Bash discards pending backslash here too.
				return Ok(if line.is_empty() && !pending_backslash {
					ReadResult::Eof(None)
				} else {
					ReadResult::Line(reader.source.decode_line(line))
				});
			},

			InputEvent::Byte(byte) => {
				// Handle backslash escape processing (when enabled).
				if config.process_escapes && !count.is_acp_character_continuation(byte) {
					if pending_backslash {
						pending_backslash = false;

						// Backslash-delimiter is line continuation.
						if config.delimiter == Some(byte) {
							continue; // Line continuation.
						}

						// For other bytes, add the byte literally (backslash consumed).
						line.push(byte);
						raw_backslashes.push(true);

						// Check character limit (based on output length).
						match count.push(byte, config.char_limit) {
							Limit::NotReached => continue,
							Limit::Reached => return Ok(ReadResult::Line(reader.source.decode_line(line))),
							Limit::Passed(past) => {
								return Ok(ReadResult::Line(
									reader.line_before_trailing_bytes(line, raw_backslashes, past),
								));
							},
						}
					}

					if byte == BACKSLASH {
						pending_backslash = true;
						continue;
					}
				}

				// When we have incomplete multibyte input, we must decide whether to
				// consume this byte to complete it. The issue: if completing would exceed
				// the limit, we'd need to unread the byte via HeldInput, which is hidden
				// from native child processes. Instead, finalize incomplete input without
				// consuming lookahead bytes: if we have pending at a limit boundary, return.
				if count.len > 0 {
					// A delimiter that cannot continue the pending multibyte
					// character marks the record boundary. If that character reaches
					// a limit, retain the delimiter for the next read.
					if config.delimiter == Some(byte)
						&& !count.is_acp_character_continuation(byte)
					{
						if matches!(count.finish(config.char_limit), Limit::Reached) {
							reader.source.unread(&[byte]);
						}
						return Ok(ReadResult::Line(reader.source.decode_line(line)));
					}

					// Check if we're at the character limit already with pending input.
					// If so, finalize the pending character(s) and return without consuming this byte.
					if config.char_limit.is_some_and(|limit| count.chars >= limit) {
						// We're at the limit with pending incomplete bytes.
						// Finalize them without reading the current byte.
						// This prevents the byte from being consumed and hidden in HeldInput.
						match count.finish(None) {
							Limit::NotReached => {},  // Pending finalized, but still under limit. Treat as complete.
							Limit::Reached | Limit::Passed(_) => {},  // Already counted in finish().
						}
						return Ok(ReadResult::Line(reader.source.decode_line(line)));
					}

					// We have pending but haven't hit the limit yet.
					// Try to complete the multibyte sequence with this byte.
					line.push(byte);
					raw_backslashes.push(false);

					match count.push(byte, config.char_limit) {
						Limit::NotReached => continue,  // Byte was consumed as part of multibyte character.
						Limit::Reached => return Ok(ReadResult::Line(reader.source.decode_line(line))),
						Limit::Passed(past) => {
							return Ok(ReadResult::Line(
								reader.line_before_trailing_bytes(line, raw_backslashes, past),
							));
						},
					}
				}

				// Check for delimiter (only if not part of pending multibyte input).
				if config.delimiter == Some(byte) {
					return Ok(ReadResult::Line(reader.source.decode_line(line)));
				}

				// Ignore non-whitespace control characters.
				if byte.is_ascii_control() && !byte.is_ascii_whitespace() {
					continue;
				}

				line.push(byte);
				raw_backslashes.push(false);

				// Check character limit (based on output length).
				match count.push(byte, config.char_limit) {
					Limit::NotReached => {},
					Limit::Reached => return Ok(ReadResult::Line(reader.source.decode_line(line))),
					Limit::Passed(past) => {
						return Ok(ReadResult::Line(
							reader.line_before_trailing_bytes(line, raw_backslashes, past),
						));
					},
				}
			},
		}
	}
}

impl ReadCommand {
	/// Reads a line of input, optionally with a timeout.
	///
	/// Handles backslash escape processing:
	/// - Without `-r`: backslash-newline is line continuation, other backslashes
	///   escape the next char
	/// - With `-r`: backslash is treated as a literal character
	fn read_line<F>(
		&self,
		input_file: brush_core::openfiles::OpenFile,
		mut stderr_file: impl std::io::Write,
		timeout: Option<Duration>,
		is_cancelled: F,
	) -> Result<ReadResult, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		let term_mode = self.setup_terminal_settings(&input_file)?;

		// Display prompt on stderr, but only if input is from a terminal (per bash
		// behavior).
		if let Some(prompt) = &self.prompt {
			if input_file.is_terminal() {
				write!(stderr_file, "{prompt}")?;
				stderr_file.flush()?;
			}
		}

		// Determine delimiter based on options. Input is matched byte by byte,
		// so a multi-byte `-d` delimiter splits at its first byte.
		let delimiter = if self.return_after_n_chars_no_delimiter.is_some() {
			None
		} else if let Some(delimiter_str) = &self.delimiter {
			Some(delimiter_str.as_bytes().first().copied().unwrap_or(NUL_DELIMITER))
		} else {
			Some(DEFAULT_DELIMITER)
		};

		let char_limit = self
			.return_after_n_chars_no_delimiter
			.or(self.return_after_n_chars);

		// Start the timeout before acquiring the shared reader guard so waiting
		// behind another builtin does not extend `-t`.
		let deadline = timeout.map(|duration| Instant::now() + duration);
		let mut reader = InputReader::new(input_file, deadline, term_mode);

		// Handle -t 0 special case: just check if input is available without reading.
		if timeout == Some(Duration::ZERO) {
			ensure_not_cancelled(&is_cancelled)?;
			return Ok(if reader.check_input_available() {
				ReadResult::InputReady
			} else {
				ReadResult::InputNotReady
			});
		}

		// Duplicated descriptors share this guard with other builtin readers.
		// Keeping it through line assembly and any pushback prevents a second
		// builtin from blocking on the descriptor while unread bytes are queued.
		let held_input = reader.source.input().held_input().cloned();
		let _read_guard = if let Some(held_input) = held_input.as_ref() {
			let Some(guard) = acquire_read_lock(held_input, reader.deadline, &is_cancelled)? else {
				return Ok(ReadResult::TimedOut(None));
			};
			Some(guard)
		} else {
			None
		};

		// Configure and perform the read.
		let config = LineReaderConfig { delimiter, char_limit, process_escapes: !self.raw_mode };

		read_line_with_reader(&mut reader, &config, &is_cancelled)
	}

	fn setup_terminal_settings(
		&self,
		file: &brush_core::openfiles::OpenFile,
	) -> Result<Option<brush_core::terminal::AutoModeGuard>, brush_core::Error> {
		// The guard dups the descriptor and reads its terminal attributes; a
		// pipe or file has none, so skip it in every `while read` iteration.
		if !file.is_terminal() {
			return Ok(None);
		}
		let mode = brush_core::terminal::AutoModeGuard::new(file.to_owned()).ok();
		if let Some(mode) = &mode {
			let config = brush_core::terminal::Settings::builder()
				.line_input(false)
				.interrupt_signals(false)
				.echo_input(!self.silent)
				.build();

			mode.apply_settings(&config)?;
		}

		Ok(mode)
	}

	/// Validates the timeout value and returns an error result if invalid.
	///
	/// Returns `Ok(Some(result))` if the timeout is invalid (caller should
	/// return early), `Ok(None)` if the timeout is valid or not specified.
	///
	/// TODO(read): Bash uses $TMOUT as a default timeout for `read` when -t is
	/// not specified.
	fn validate_timeout(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<Option<brush_core::ExecutionResult>, brush_core::Error> {
		if let Some(timeout) = self.timeout_in_seconds {
			if timeout < 0.0 {
				writeln!(
					context.stderr(),
					"{}: -t: invalid timeout specification",
					context.command_name
				)?;
				return Ok(Some(brush_core::ExecutionResult::general_error()));
			}
		}
		Ok(None)
	}
}

/// Splits a line by IFS (Internal Field Separator) according to shell rules.
///
/// Shell IFS splitting has special rules:
/// - Whitespace IFS chars (space, tab, newline) are "IFS whitespace"
/// - Leading/trailing IFS whitespace is trimmed from the input
/// - Consecutive IFS whitespace chars act as a single delimiter
/// - Non-whitespace IFS chars each act as individual delimiters
/// - Trailing non-whitespace delimiter does NOT create an empty final field
///
/// # Arguments
/// * `ifs` - The IFS string (typically " \t\n")
/// * `line` - The input line to split
/// * `max_fields` - Optional limit on number of fields (for `read var1 var2`)
fn split_line_by_ifs(ifs: &str, line: &str, max_fields: Option<usize>) -> VecDeque<String> {
	let ifs_chars: Vec<char> = ifs.chars().collect();

	// Helper to check if a char is IFS whitespace (space, tab, or newline AND in
	// IFS).
	let is_ifs_whitespace =
		|c: char| -> bool { (c == ' ' || c == '\t' || c == '\n') && ifs_chars.contains(&c) };

	// Trim leading/trailing IFS whitespace from the input.
	let trimmed_line = line.trim_matches(&is_ifs_whitespace);
	if trimmed_line.is_empty() {
		return VecDeque::new();
	}

	let max_fields = max_fields.unwrap_or(usize::MAX);

	// State machine for splitting:
	// - `consuming_whitespace_run`: Currently skipping consecutive IFS whitespace
	// - `prev_was_non_ws_delim`: Previous char was a non-whitespace delimiter
	// - `collecting_remainder`: We've hit max_fields, collect everything into last
	//   field
	let mut fields = VecDeque::new();
	let mut current_field = String::new();
	let mut consuming_whitespace_run = false;
	let mut prev_was_non_ws_delim = false;
	let mut collecting_remainder = false;

	for c in trimmed_line.chars() {
		// Skip consecutive IFS whitespace (they act as single delimiter).
		if consuming_whitespace_run && is_ifs_whitespace(c) {
			continue;
		}
		consuming_whitespace_run = false;

		let is_delimiter = ifs_chars.contains(&c);
		let at_field_limit = fields.len() + 1 >= max_fields;

		if !at_field_limit && is_delimiter {
			// Normal case: delimiter ends current field, start new one.
			fields.push_back(std::mem::take(&mut current_field));
			consuming_whitespace_run = is_ifs_whitespace(c);
			prev_was_non_ws_delim = !consuming_whitespace_run;
		} else if at_field_limit && !collecting_remainder && is_delimiter {
			// At field limit but haven't started last field content yet.
			// Skip leading IFS whitespace for the final field.
			if is_ifs_whitespace(c) {
				consuming_whitespace_run = true;
			} else {
				// Non-whitespace delimiters at boundary: include in remainder.
				// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
				collecting_remainder = true;
				current_field.push(c);
			}
		} else {
			// Regular character: add to current field.
			collecting_remainder = at_field_limit;
			current_field.push(c);
			prev_was_non_ws_delim = false;
		}
	}

	// Finalize: push last field unless it's empty AND we ended with non-ws
	// delimiter. e.g., "a,b,c," with IFS="," gives ["a", "b", "c"], not ["a", "b",
	// "c", ""].
	if !current_field.is_empty() || !prev_was_non_ws_delim {
		fields.push_back(current_field);
	}

	fields
}

#[cfg(test)]
mod tests {
	use itertools::assert_equal;

	use super::*;

	// ==================== split_line_by_ifs tests ====================

	#[test]
	fn test_split_line_by_ifs_basic() {
		let result = split_line_by_ifs(",", "a,b,c", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_leading_or_trailing_space() {
		let result = split_line_by_ifs(" ", "  a b c ", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_extra_interior_space() {
		let result = split_line_by_ifs(" ", "a  b c", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_leading_non_space_delimiter() {
		let result = split_line_by_ifs(",", ",a,b,c", None);
		assert_equal(result, VecDeque::from(vec!["", "a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_trailing_non_space_delimiter() {
		// Bash does NOT include empty trailing field when input ends with non-ws
		// delimiter.
		let result = split_line_by_ifs(",", "a,b,c,", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_max_fields() {
		// With max_fields=2, remainder goes into second field.
		let result = split_line_by_ifs(" ", "a b c d", Some(2));
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[test]
	fn test_split_line_by_ifs_max_fields_with_non_ws_delimiter() {
		// With max_fields and non-whitespace delimiter.
		let result = split_line_by_ifs(",", "a,b,c,d", Some(2));
		assert_equal(result, VecDeque::from(vec!["a", "b,c,d"]));
	}

	#[test]
	fn test_split_line_by_ifs_consecutive_delimiters_at_boundary() {
		// Consecutive non-whitespace delimiters at field boundary should be preserved.
		// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
		let result = split_line_by_ifs(":", "x::y", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", ":y"]));

		// Triple delimiter at boundary.
		let result = split_line_by_ifs(":", "x:::y", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", "::y"]));

		// Delimiter in middle of remainder is also preserved.
		let result = split_line_by_ifs(":", "x:y:z:w", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", "y:z:w"]));
	}

	#[test]
	fn test_split_line_by_ifs_mixed_delimiters() {
		// Mixed whitespace and non-whitespace in IFS.
		let result = split_line_by_ifs(": ", "a:b  c:d", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c", "d"]));
	}

	#[test]
	fn test_split_line_by_ifs_empty_input() {
		let result = split_line_by_ifs(" ", "", None);
		assert_equal(result, VecDeque::<String>::new());
	}

	#[test]
	fn test_split_line_by_ifs_whitespace_only() {
		let result = split_line_by_ifs(" ", "   ", None);
		assert_equal(result, VecDeque::<String>::new());
	}

	#[test]
	fn test_split_line_by_ifs_consecutive_non_ws_delimiters() {
		// Consecutive non-whitespace delimiters create empty fields.
		let result = split_line_by_ifs(",", "a,,b", None);
		assert_equal(result, VecDeque::from(vec!["a", "", "b"]));
	}

	// ==================== build_array_fields tests ====================

	#[test]
	fn test_build_array_fields_basic() {
		let result = build_array_fields(Some("a b c"), " ", false);
		assert_eq!(result, vec![
			(None, "a".to_string()),
			(None, "b".to_string()),
			(None, "c".to_string())
		]);
	}

	#[test]
	fn test_build_array_fields_skip_splitting() {
		// With -N option, entire input goes as single element.
		let result = build_array_fields(Some("a b c"), " ", true);
		assert_eq!(result, vec![(None, "a b c".to_string())]);
	}

	#[test]
	fn test_build_array_fields_none_input() {
		let result = build_array_fields(None, " ", false);
		assert!(result.is_empty());
	}

	// ==================== build_variable_fields tests ====================

	#[test]
	fn test_build_variable_fields_basic() {
		let result = build_variable_fields(Some("a b c"), " ", false, 3);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_build_variable_fields_fewer_vars_than_fields() {
		// Last variable gets remainder.
		let result = build_variable_fields(Some("a b c d"), " ", false, 2);
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[test]
	fn test_build_variable_fields_skip_splitting() {
		// With -N option, entire input goes to first variable.
		let result = build_variable_fields(Some("a b c"), " ", true, 3);
		assert_equal(result, VecDeque::from(vec!["a b c"]));
	}

	#[test]
	fn test_build_variable_fields_none_input() {
		let result = build_variable_fields(None, " ", false, 3);
		assert!(result.is_empty());
	}

	fn test_command() -> ReadCommand {
		ReadCommand {
			array_variable: None,
			delimiter: None,
			use_readline: false,
			initial_text: None,
			return_after_n_chars: None,
			return_after_n_chars_no_delimiter: None,
			prompt: None,
			raw_mode: false,
			silent: false,
			timeout_in_seconds: None,
			fd_num_to_read: None,
			variable_names: Vec::new(),
		}
	}

	#[cfg(windows)]
	#[derive(Clone)]
	struct CursorStream(std::sync::Arc<std::sync::Mutex<std::io::Cursor<Vec<u8>>>>);

	#[cfg(windows)]
	impl std::io::Read for CursorStream {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			std::io::Read::read(&mut *self.0.lock().expect("cursor lock"), buf)
		}
	}

	#[cfg(windows)]
	impl std::io::Write for CursorStream {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			std::io::Write::write(&mut *self.0.lock().expect("cursor lock"), buf)
		}

		fn flush(&mut self) -> std::io::Result<()> {
			std::io::Write::flush(&mut *self.0.lock().expect("cursor lock"))
		}
	}

	#[cfg(windows)]
	impl brush_core::openfiles::Stream for CursorStream {
		fn clone_box(&self) -> Box<dyn brush_core::openfiles::Stream> {
			Box::new(self.clone())
		}
	}

	#[cfg(windows)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn cancellation_after_acp_selection_persists_for_the_next_read() -> anyhow::Result<()> {
		let cursor = std::sync::Arc::new(std::sync::Mutex::new(std::io::Cursor::new(vec![
			0xff, 0xd2, 0xbb, b'\n',
		])));
		let input = OpenFile::Stream(
			Box::new(CursorStream(std::sync::Arc::clone(&cursor))),
			HeldInput::default(),
		);
		let held = input.held_input().expect("stream holds decoder state").clone();
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(936));

		let interrupted = test_command().read_line(input.try_clone()?, Vec::<u8>::new(), None, || {
			cursor.lock().expect("cursor lock").position() > 0
		});
		assert!(matches!(interrupted, Err(ref error) if error.to_string() == "interrupted"));
		assert!(held.output_decoder_state().uses_acp());

		assert!(matches!(
			test_command().read_line(input, Vec::<u8>::new(), None, || false)?,
			ReadResult::Line(ref text) if text == "一"
		));
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn read_n_and_read_cap_count_gbk_pairs_after_acp_selection() -> anyhow::Result<()> {
		for no_delimiter in [false, true] {
			// D2 BB is CP936 一 and valid UTF-8 U+04BB. Only the retained ACP
			// choice disambiguates it correctly after the first line.
			let contents = vec![0xff, b'\n', 0xd2, 0xbb, b'X', b'\n'];
			let stream = CursorStream(std::sync::Arc::new(std::sync::Mutex::new(
				std::io::Cursor::new(contents),
			)));
			let input = OpenFile::Stream(Box::new(stream), HeldInput::default());
			input
				.held_input()
				.expect("stream holds decoder state")
				.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(936));

			let first = test_command().read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(first, ReadResult::Line(_)));
			assert!(input
				.held_input()
				.expect("stream holds decoder state")
				.output_decoder_state()
				.uses_acp());

			let limited = ReadCommand {
				raw_mode: true,
				return_after_n_chars: (!no_delimiter).then_some(1),
				return_after_n_chars_no_delimiter: no_delimiter.then_some(1),
				..test_command()
			};
			assert!(matches!(
				limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "一"
			));

			assert!(matches!(
				test_command().read_line(input, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "X"
			));
		}
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn read_n_and_read_cap_count_gb18030_four_byte_characters() -> anyhow::Result<()> {
		for no_delimiter in [false, true] {
			let contents = vec![0xff, b'\n', 0x90, 0x30, 0x81, 0x30, b'X', b'\n'];
			let stream = CursorStream(std::sync::Arc::new(std::sync::Mutex::new(
				std::io::Cursor::new(contents),
			)));
			let input = OpenFile::Stream(Box::new(stream), HeldInput::default());
			input
				.held_input()
				.expect("stream holds decoder state")
				.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(54936));

			let first = test_command().read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(first, ReadResult::Line(_)));
			assert!(input
				.held_input()
				.expect("stream holds decoder state")
				.output_decoder_state()
				.uses_acp());

			let limited = ReadCommand {
				raw_mode: true,
				return_after_n_chars: (!no_delimiter).then_some(1),
				return_after_n_chars_no_delimiter: no_delimiter.then_some(1),
				..test_command()
			};
			assert!(matches!(
				limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "𐀀"
			));

			assert!(matches!(
				test_command().read_line(input, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "X"
			));
		}
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn read_n_and_read_cap_leave_invalid_cp932_trail_for_the_next_read() -> anyhow::Result<()> {
		for no_delimiter in [false, true] {
			let contents = vec![0xff, b'\n', 0x81, 0x20, b'X', b'\n'];
			let stream = CursorStream(std::sync::Arc::new(std::sync::Mutex::new(
				std::io::Cursor::new(contents),
			)));
			let input = OpenFile::Stream(Box::new(stream), HeldInput::default());
			input
				.held_input()
				.expect("stream holds decoder state")
				.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(932));

			let first = test_command().read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(first, ReadResult::Line(_)));

			let limited = ReadCommand {
				raw_mode: true,
				return_after_n_chars: (!no_delimiter).then_some(1),
				return_after_n_chars_no_delimiter: no_delimiter.then_some(1),
				..test_command()
			};
			assert!(matches!(
				limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "\u{FFFD}"
			));

			assert!(matches!(
				test_command().read_line(input, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == " X"
			));
		}
		Ok(())
	}

	#[cfg(windows)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn read_n_and_read_cap_preserve_cp932_backslash_trail() -> anyhow::Result<()> {
		use std::io::Write;

		for no_delimiter in [false, true] {
			let (reader, mut writer) = std::io::pipe()?;
			let input = OpenFile::from(reader);
			let held = input.held_input().expect("pipe holds input").clone();
			let mut decoder_state = OutputDecoderState::with_fallback_codepage(932);
			assert!(decoder_state.select_acp_fallback());
			held.set_output_decoder_state(decoder_state);
			writer.write_all(&[0x83, 0x5c, b'A', b'\n'])?;
			drop(writer);

			let limited = ReadCommand {
				return_after_n_chars: (!no_delimiter).then_some(1),
				return_after_n_chars_no_delimiter: no_delimiter.then_some(1),
				..test_command()
			};
			assert!(matches!(
				limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "ソ"
			));

			assert!(matches!(
				test_command().read_line(input, Vec::<u8>::new(), None, || false)?,
				ReadResult::Line(ref text) if text == "A"
			));
		}
		Ok(())
	}

	#[test]
	fn test_ensure_not_cancelled_returns_interrupted() {
		let is_cancelled = || true;

		let err = ensure_not_cancelled(&is_cancelled)
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
	}

	#[cfg(unix)]
	#[test]
	fn test_read_line_returns_interrupted_when_cancelled_before_input() {
		let command = test_command();
		let (reader, _writer) = std::io::pipe().expect("pipe creation must succeed");
		let input_file = brush_core::openfiles::OpenFile::from(reader);

		let err = command
			.read_line(input_file, Vec::<u8>::new(), None, || true)
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
	}

	/// A pipe reader that, right after handing out its first byte, lets a
	/// second reader of the same pipe drain whatever else was ready.
	#[cfg(unix)]
	struct DrainedAfterFirstByte {
		reader:  std::io::PipeReader,
		other:   std::io::PipeReader,
		drained: bool,
	}

	#[cfg(unix)]
	impl std::io::Read for DrainedAfterFirstByte {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			let n = self.reader.read(buf)?;
			if !self.drained {
				self.drained = true;
				let mut rest = [0_u8; 1];
				self.other.read_exact(&mut rest)?;
			}
			Ok(n)
		}
	}

	#[cfg(unix)]
	impl std::io::Write for DrainedAfterFirstByte {
		fn write(&mut self, _buf: &[u8]) -> std::io::Result<usize> {
			Err(std::io::ErrorKind::Unsupported.into())
		}

		fn flush(&mut self) -> std::io::Result<()> {
			Ok(())
		}
	}

	#[cfg(unix)]
	impl brush_core::openfiles::Stream for DrainedAfterFirstByte {
		fn clone_box(&self) -> Box<dyn brush_core::openfiles::Stream> {
			unimplemented!("not cloned by read")
		}

		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, brush_core::Error> {
			Err(brush_core::ErrorKind::CannotConvertToNativeFd.into())
		}

		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, brush_core::Error> {
			use std::os::fd::AsFd;
			Ok(self.reader.as_fd())
		}
	}

	/// Regression: another reader of a shared pipe can drain bytes this
	/// `read` saw ready. Every byte must still wait through the poll, so the
	/// read times out instead of blocking while the writer stays open.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_times_out_after_another_reader_drains_the_pipe() -> anyhow::Result<()> {
		use std::io::Write;

		let command = test_command();
		let (reader, mut writer) = std::io::pipe()?;
		let other = reader.try_clone()?;
		writer.write_all(b"ab")?;
		let input_file = brush_core::openfiles::OpenFile::Stream(
			Box::new(DrainedAfterFirstByte { reader, other, drained: false }),
			brush_core::openfiles::HeldInput::default(),
		);

		let result =
			command.read_line(input_file, Vec::<u8>::new(), Some(Duration::from_millis(200)), || false)?;
		assert!(matches!(result, ReadResult::TimedOut(Some(ref line)) if line == "a"));
		drop(writer);
		Ok(())
	}

	/// Contract: a `-n`/`-N` read of a pipe holds the byte read past its
	/// limit, and the next read of the same pipe gets it first.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_count_holds_the_byte_past_the_limit() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		writer.write_all(b"\xC3AB\n\xC3AB\n")?;
		drop(writer);
		let pipe = OpenFile::from(reader);
		let plain = ReadCommand { raw_mode: true, ..test_command() };
		let count = ReadCommand { raw_mode: true, return_after_n_chars: Some(1), ..test_command() };
		let exact =
			ReadCommand { raw_mode: true, return_after_n_chars_no_delimiter: Some(1), ..test_command() };

		for limited in [count, exact] {
			let result = limited.read_line(pipe.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(result, ReadResult::Line(ref line) if line == "\u{FFFD}"));
			let result = plain.read_line(pipe.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(result, ReadResult::Line(ref line) if line == "AB"));
		}
		Ok(())
	}

	/// Contract: concurrent reads of duplicated pipe descriptors serialize
	/// around a character-limit pushback, so a waiting reader gets the byte
	/// from the held queue instead of timing out on an empty pipe.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_concurrent_reads_see_character_limit_pushback() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		let first_input = brush_core::openfiles::OpenFile::from(reader);
		let held = first_input.held_input().expect("pipe holds input").clone();
		let second_input = first_input.try_clone()?;
		let first_command = ReadCommand { raw_mode: true, return_after_n_chars: Some(1), ..test_command() };
		let expected_first = brush_core::output_decode::decode_owned_bytes(vec![0xc3]);
		let (first_sender, first_receiver) = std::sync::mpsc::channel();
		let first = std::thread::spawn(move || {
			let result = first_command.read_line(first_input, Vec::<u8>::new(), None, || false);
			let _ = first_sender.send(matches!(result, Ok(ReadResult::Line(line)) if line == expected_first));
		});

		let lock_deadline = Instant::now() + Duration::from_secs(5);
		loop {
			if held.try_lock_reader().is_none() {
				break;
			}
			assert!(Instant::now() < lock_deadline, "first read did not acquire the descriptor lock");
			std::thread::sleep(Duration::from_millis(1));
		}

		let (second_waiting_sender, second_waiting_receiver) = std::sync::mpsc::channel();
		let (second_sender, second_receiver) = std::sync::mpsc::channel();
		let second = std::thread::spawn(move || {
			let result = test_command().read_line(
				second_input,
				Vec::<u8>::new(),
				Some(Duration::from_secs(2)),
				move || {
					let _ = second_waiting_sender.send(());
					false
				},
			);
			let _ = second_sender.send(matches!(result, Ok(ReadResult::Line(line)) if line == "A"));
		});

		second_waiting_receiver.recv_timeout(Duration::from_secs(5))?;
		writer.write_all(b"\xC3A\nB\n")?;
		drop(writer);
		assert_eq!(first_receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
		assert_eq!(second_receiver.recv_timeout(Duration::from_secs(5)), Ok(true));
		first.join().expect("first read thread");
		second.join().expect("second read thread");
		Ok(())
	}

	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_timeout_includes_waiting_for_the_shared_reader_lock() -> anyhow::Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = brush_core::openfiles::OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input").clone();
		let _guard = held.lock_reader();

		let result = test_command().read_line(
			input,
			Vec::<u8>::new(),
			Some(Duration::from_millis(50)),
			|| false,
		)?;
		assert!(matches!(result, ReadResult::TimedOut(None)));
		Ok(())
	}

	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_timeout_after_lock_wait_does_not_consume_held_input() -> anyhow::Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = brush_core::openfiles::OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input").clone();
		held.put_back(b"A");
		let lock = std::cell::RefCell::new(Some(held.lock_reader()));
		let cancellation_checks = std::cell::Cell::new(0);
		let command = ReadCommand { delimiter: Some("A".to_owned()), ..test_command() };

		let result = command.read_line(
			input,
			Vec::<u8>::new(),
			Some(Duration::from_millis(20)),
			|| {
				let check = cancellation_checks.get();
				cancellation_checks.set(check + 1);
				if check == 1 {
					// Release the other reader's lock only after this read's deadline.
					std::thread::sleep(Duration::from_millis(40));
					drop(lock.borrow_mut().take());
				}
				false
			},
		)?;

		assert!(matches!(result, ReadResult::TimedOut(None)));
		assert_eq!(held.pop(), Some(b'A'));
		Ok(())
	}

	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_timeout_before_servicing_held_input_keeps_it_queued() -> anyhow::Result<()> {
		let (reader, _writer) = std::io::pipe()?;
		let input = brush_core::openfiles::OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds input").clone();
		held.put_back(b"A");
		let cancellation_checks = std::cell::Cell::new(0);
		let command = ReadCommand { delimiter: Some("A".to_owned()), ..test_command() };

		let result = command.read_line(
			input,
			Vec::<u8>::new(),
			Some(Duration::from_millis(20)),
			|| {
				let check = cancellation_checks.get();
				cancellation_checks.set(check + 1);
				if check == 1 {
					// The lock is acquired, but input is not serviced until the timeout.
					std::thread::sleep(Duration::from_millis(40));
				}
				false
			},
		)?;

		assert!(matches!(result, ReadResult::TimedOut(None)));
		assert_eq!(held.pop(), Some(b'A'));
		Ok(())
	}

	/// Contract: `-t 0` reports held input as ready without taking it.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_t_0_reports_held_input_ready() -> anyhow::Result<()> {
		let command = test_command();
		let (reader, _writer) = std::io::pipe()?;
		let pipe = OpenFile::from(reader);
		let held = pipe.held_input().expect("a pipe holds input").clone();

		let result = command.read_line(pipe.try_clone()?, Vec::<u8>::new(), Some(Duration::ZERO), || false)?;
		assert!(matches!(result, ReadResult::InputNotReady));
		held.put_back(b"A");
		let result = command.read_line(pipe, Vec::<u8>::new(), Some(Duration::ZERO), || false)?;
		assert!(matches!(result, ReadResult::InputReady));
		assert_eq!(held.pop(), Some(b'A'));
		Ok(())
	}

	/// Contract: a read cancelled before it takes a byte leaves held input
	/// in place.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_cancelled_leaves_held_input() -> anyhow::Result<()> {
		let command = test_command();
		let (reader, _writer) = std::io::pipe()?;
		let pipe = OpenFile::from(reader);
		let held = pipe.held_input().expect("a pipe holds input").clone();
		held.put_back(b"A");

		let err = command
			.read_line(pipe, Vec::<u8>::new(), None, || true)
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
		assert_eq!(held.pop(), Some(b'A'));
		Ok(())
	}

	/// Contract: held input is served without waiting on the descriptor;
	/// the deadline applies once it runs out.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_serves_held_input_before_waiting() -> anyhow::Result<()> {
		let command = test_command();
		let (reader, _writer) = std::io::pipe()?;
		let pipe = OpenFile::from(reader);
		pipe.held_input().expect("a pipe holds input").put_back(b"A");

		let result =
			command.read_line(pipe, Vec::<u8>::new(), Some(Duration::from_millis(100)), || false)?;
		assert!(matches!(result, ReadResult::TimedOut(Some(ref line)) if line == "A"));
		Ok(())
	}

	/// A timed-out incomplete character is finalized into the partial result.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_timeout_returns_incomplete_utf8_in_partial_result() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		let held = input.held_input().expect("pipe holds timed-out input").clone();
		#[cfg(windows)]
		held.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(65001));
		writer.write_all(&[b'A', 0xc3])?;

		let timed_out = test_command().read_line(
			input.try_clone()?,
			Vec::<u8>::new(),
			Some(Duration::from_millis(100)),
			|| false,
		)?;
		let partial = match timed_out {
			ReadResult::TimedOut(Some(partial)) => partial,
			other => panic!("expected partial input on timeout, got {other:?}"),
		};
		assert_eq!(partial, "A\u{FFFD}");
		assert!(held.is_empty(), "timed-out bytes must not be hidden from non-builtin readers");
		Ok(())
	}

	/// Regression: when another reader of the description takes the held
	/// byte between this read's checks, the read must poll before reading,
	/// so it times out instead of blocking while the writer stays open.
	#[cfg(unix)]
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_line_times_out_when_another_reader_drains_held_input() -> anyhow::Result<()> {
		let (reader, writer) = std::io::pipe()?;
		let a = OpenFile::from(reader);
		a.held_input().expect("a pipe holds input").put_back(b"A");
		let b = a.try_clone()?;
		let drain = b.held_input().expect("a pipe holds input").clone();

		let (sender, receiver) = std::sync::mpsc::channel();
		let thread = std::thread::spawn(move || {
			// The cancellation check runs right before the pop, so the other
			// reader drains the byte exactly there.
			let result = test_command().read_line(
				a,
				Vec::<u8>::new(),
				Some(Duration::from_millis(200)),
				move || {
					drain.pop();
					false
				},
			);
			let _ = sender.send(matches!(result, Ok(ReadResult::TimedOut(None))));
		});

		let outcome = receiver.recv_timeout(Duration::from_secs(5));
		drop(writer);
		let _ = thread.join();
		assert_eq!(outcome, Ok(true), "read must time out, not block or take the drained byte");
		assert!(b.held_input().expect("a pipe holds input").is_empty());
		Ok(())
	}

	/// Regression: malformed UTF-8 lead byte followed by delimiter should not
	/// consume the delimiter. When `0xC3\n` is read with `-n 1` and default
	/// delimiter (newline), the 0x0A is used to classify the 0xC3 as invalid,
	/// but should not be consumed as the delimiter terminator.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_n_preserves_delimiter_after_malformed_utf8() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);

		// Write: malformed UTF-8 lead byte 0xC3, then newline, then 'X'
		writer.write_all(&[0xc3, b'\n', b'X', b'\n'])?;
		drop(writer);

		let limited = ReadCommand {
			raw_mode: true,
			return_after_n_chars: Some(1),
			..test_command()
		};

		// First read: -n 1 should read one character (the invalid UTF-8)
		let first = limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
		assert!(matches!(first, ReadResult::Line(ref text) if text == "\u{FFFD}"));

		// Second read: should get the line with just the newline (empty after delimiter)
		let second = test_command().read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
		assert!(matches!(second, ReadResult::Line(ref text) if text == ""));

		// Third read: should get 'X'
		let third = test_command().read_line(input, Vec::<u8>::new(), None, || false)?;
		assert!(matches!(third, ReadResult::Line(ref text) if text == "X"));
		Ok(())
	}

	/// An unbounded raw read treats the delimiter after malformed UTF-8 as the
	/// record boundary, for both the default newline and a custom delimiter.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_unbounded_read_preserves_delimiters_after_malformed_utf8() -> anyhow::Result<()> {
		use std::io::Write;

		for (delimiter, delimiter_byte) in [(None, b'\n'), (Some("|".to_owned()), b'|')] {
			let (reader, mut writer) = std::io::pipe()?;
			let input = OpenFile::from(reader);
			#[cfg(windows)]
			input
				.held_input()
				.expect("pipe holds decoder state")
				.set_output_decoder_state(OutputDecoderState::with_fallback_codepage(65001));
			writer.write_all(&[0xc3, delimiter_byte])?;
			writer.write_all(b"next")?;
			writer.write_all(&[delimiter_byte])?;
			drop(writer);

			let command = ReadCommand { raw_mode: true, delimiter, ..test_command() };
			let first = command.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(first, ReadResult::Line(ref text) if !text.is_empty()));

			let second = command.read_line(input, Vec::<u8>::new(), None, || false)?;
			assert!(matches!(second, ReadResult::Line(ref text) if text == "next"));
		}
		Ok(())
	}

	/// `-N` ignores delimiters even when a delimiter byte resolves an incomplete
	/// UTF-8 prefix; only a reached character limit pushes that byte back.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_read_cap_ignores_delimiter_after_malformed_utf8() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);
		writer.write_all(&[0xc3, b'\n', b'X', b'\n'])?;
		drop(writer);

		let capped = ReadCommand {
			raw_mode: true,
			return_after_n_chars_no_delimiter: Some(1),
			..test_command()
		};
		let first = capped.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
		assert!(matches!(first, ReadResult::Line(ref text) if !text.is_empty()));

		let second = capped.read_line(input, Vec::<u8>::new(), None, || false)?;
		assert!(matches!(second, ReadResult::Line(ref text) if text == "\n"));
		Ok(())
	}

	/// Native child reads after builtin read with malformed UTF-8 and lookahead.
	/// When read -r -n 1 encounters malformed UTF-8 (0xC3 followed by 0x41),
	/// it should not consume 0x41 in a way that hides it from external readers.
	#[test]
	#[expect(clippy::panic_in_result_fn)]
	fn test_native_child_sees_bytes_after_malformed_utf8_lookahead() -> anyhow::Result<()> {
		use std::io::Write;

		let (reader, mut writer) = std::io::pipe()?;
		let input = OpenFile::from(reader);

		// Input: malformed UTF-8 lead byte, non-continuation byte, newline
		writer.write_all(&[0xc3, b'A', b'\n'])?;
		drop(writer);

		let limited = ReadCommand {
			raw_mode: true,
			return_after_n_chars: Some(1),
			..test_command()
		};

		// First read: -n 1 should read one character (the invalid UTF-8 byte 0xC3)
		let first = limited.read_line(input.try_clone()?, Vec::<u8>::new(), None, || false)?;
		let first_text = match first {
			ReadResult::Line(text) => text,
			_ => panic!("expected line"),
		};
		// The malformed 0xC3 becomes U+FFFD (replacement character)
		assert_eq!(first_text, "\u{FFFD}");

		// Second read: should get 'A' followed by newline delimiter
		let second = test_command().read_line(input, Vec::<u8>::new(), None, || false)?;
		let second_text = match second {
			ReadResult::Line(text) => text,
			_ => panic!("expected line"),
		};
		// The 0x41 ('A') should be available and processed
		assert_eq!(second_text, "A");
		Ok(())
	}
}
