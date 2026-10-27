//! Managing files open within a shell instance.

use std::{
	collections::{HashMap, VecDeque},
	io::IsTerminal,
	process::Stdio,
	sync::{Arc, Mutex, MutexGuard, PoisonError, TryLockError},
};

use crate::{ShellFd, error, ioutils, output_decode::OutputDecoderState, sys};

/// A trait representing a stream that can be read from and written to.
/// This is used for custom stream implementations in `OpenFile`.
///
/// Types that implement this trait are expected to be cloneable via the
/// `clone_box` function.
pub trait Stream: std::io::Read + std::io::Write + Send + Sync {
	/// Clones the stream into a boxed trait object.
	fn clone_box(&self) -> Box<dyn Stream>;
	/// Whether this stream is backed by a terminal. On Unix, implementations
	/// must also expose the terminal descriptor through `try_borrow_as_fd`.
	fn is_terminal(&self) -> bool {
		false
	}

	/// Converts the stream into an `OwnedFd`. Returns an error if the operation
	/// is not supported or if it fails.
	#[cfg(unix)]
	fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, error::Error>;

	/// Borrows the stream as a `BorrowedFd`. Returns an error if the operation
	/// is not supported or if it fails.
	#[cfg(unix)]
	fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error>;
}

/// Input that a builtin read from an open file description past what it
/// consumed, like bash's `zungetc` pushback. The next builtin read of the
/// description takes it first; external commands never see it.
///
/// Every duplicate made by [`OpenFile::try_clone`] shares the store, and it
/// ends with the last duplicate. Identity is the `OpenFile` value and its
/// `try_clone` lineage, so an `OpenFile` built from a raw descriptor starts
/// with an empty store.
#[derive(Clone, Default)]
pub struct HeldInput {
	bytes:      Arc<Mutex<VecDeque<u8>>>,
	read_lock:  Arc<Mutex<()>>,
	decoder:    Arc<Mutex<OutputDecoderState>>,
}

impl HeldInput {
	/// Takes the first held byte, if any.
	pub fn pop(&self) -> Option<u8> {
		self.lock_bytes().pop_front()
	}

	/// Holds `bytes` ahead of anything already held, in input order.
	pub fn put_back(&self, bytes: &[u8]) {
		let mut held = self.lock_bytes();
		for &byte in bytes.iter().rev() {
			held.push_front(byte);
		}
	}

	/// Whether nothing is held.
	pub fn is_empty(&self) -> bool {
		self.lock_bytes().is_empty()
	}

	/// Returns the decoder selection shared by builtin readers of this input.
	pub fn output_decoder_state(&self) -> OutputDecoderState {
		*self.decoder.lock().unwrap_or_else(PoisonError::into_inner)
	}

	/// Retains the decoder selection for the next line from this input.
	pub fn set_output_decoder_state(&self, state: OutputDecoderState) {
		*self.decoder.lock().unwrap_or_else(PoisonError::into_inner) = state;
	}

	/// Serializes builtin readers of this open file description. A reader holds
	/// this guard until it has either consumed a line or put back any byte it
	/// read past its limit, so another reader cannot wait on the descriptor while
	/// that byte moves into the held-input queue.
	pub fn lock_reader(&self) -> MutexGuard<'_, ()> {
		self.read_lock.lock().unwrap_or_else(PoisonError::into_inner)
	}

	/// Tries to serialize a builtin reader without blocking.
	pub fn try_lock_reader(&self) -> Option<MutexGuard<'_, ()>> {
		match self.read_lock.try_lock() {
			Ok(guard) => Some(guard),
			Err(TryLockError::WouldBlock) => None,
			Err(TryLockError::Poisoned(error)) => Some(error.into_inner()),
		}
	}

	fn lock_bytes(&self) -> MutexGuard<'_, VecDeque<u8>> {
		self.bytes.lock().unwrap_or_else(PoisonError::into_inner)
	}
}

/// Represents a file open in a shell context.
pub enum OpenFile {
	/// The original standard input this process was started with.
	Stdin(std::io::Stdin, HeldInput),
	/// The original standard output this process was started with.
	Stdout(std::io::Stdout),
	/// The original standard error this process was started with.
	Stderr(std::io::Stderr),
	/// A file open for reading or writing.
	File(std::fs::File, HeldInput),
	/// A read end of a pipe.
	PipeReader(std::io::PipeReader, HeldInput),
	/// A write end of a pipe.
	PipeWriter(std::io::PipeWriter),
	/// A custom stream.
	Stream(Box<dyn Stream>, HeldInput),
}

#[cfg(feature = "serde")]
impl serde::Serialize for OpenFile {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		match self {
			Self::Stdin(..) => serializer.serialize_str("stdin"),
			Self::Stdout(_) => serializer.serialize_str("stdout"),
			Self::Stderr(_) => serializer.serialize_str("stderr"),
			Self::File(..) => serializer.serialize_str("file"),
			Self::PipeReader(..) => serializer.serialize_str("pipe_reader"),
			Self::PipeWriter(_) => serializer.serialize_str("pipe_writer"),
			Self::Stream(..) => serializer.serialize_str("stream"),
		}
	}
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for OpenFile {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		match String::deserialize(deserializer)?.as_str() {
			"stdin" => return Ok(std::io::stdin().into()),
			"stdout" => return Ok(std::io::stdout().into()),
			"stderr" => return Ok(std::io::stderr().into()),
			"file" => (),
			"pipe_reader" => (),
			"pipe_writer" => (),
			"stream" => (),
			_ => return Err(serde::de::Error::custom("invalid open file")),
		}

		// TODO(serde): Figure out something better to do with open pipes and files.
		null().map_err(serde::de::Error::custom)
	}
}

/// Returns an open file that will discard all I/O.
pub fn null() -> Result<OpenFile, error::Error> {
	let file = sys::fs::open_null_file()?;
	Ok(file.into())
}

impl Clone for OpenFile {
	fn clone(&self) -> Self {
		// If we fail to clone the open file for any reason, we return a special file
		// that discards all I/O. This allows us to avoid fatally erroring out.
		self.try_clone().unwrap_or_else(|_err| {
			ioutils::FailingReaderWriter::new("failed to duplicate open file").into()
		})
	}
}

impl std::fmt::Display for OpenFile {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Stdin(..) => write!(f, "stdin"),
			Self::Stdout(_) => write!(f, "stdout"),
			Self::Stderr(_) => write!(f, "stderr"),
			Self::File(..) => write!(f, "file"),
			Self::PipeReader(..) => write!(f, "pipe reader"),
			Self::PipeWriter(_) => write!(f, "pipe writer"),
			Self::Stream(..) => write!(f, "stream"),
		}
	}
}

impl OpenFile {
	/// Tries to duplicate the open file.
	pub fn try_clone(&self) -> Result<Self, std::io::Error> {
		let result = match self {
			Self::Stdin(_, held) => Self::Stdin(std::io::stdin(), held.clone()),
			Self::Stdout(_) => std::io::stdout().into(),
			Self::Stderr(_) => std::io::stderr().into(),
			Self::File(f, held) => Self::File(f.try_clone()?, held.clone()),
			Self::PipeReader(f, held) => Self::PipeReader(f.try_clone()?, held.clone()),
			Self::PipeWriter(f) => f.try_clone()?.into(),
			Self::Stream(s, held) => Self::Stream(s.clone_box(), held.clone()),
		};

		Ok(result)
	}

	/// Converts the open file into an `OwnedFd`.
	#[cfg(unix)]
	pub(crate) fn try_clone_to_owned(self) -> Result<std::os::fd::OwnedFd, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f, _) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stdout(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::Stderr(f) => Ok(f.as_fd().try_clone_to_owned()?),
			Self::File(f, _) => Ok(f.into()),
			Self::PipeReader(r, _) => Ok(std::os::fd::OwnedFd::from(r)),
			Self::PipeWriter(w) => Ok(std::os::fd::OwnedFd::from(w)),
			Self::Stream(s, _) => s.try_clone_to_owned(),
		}
	}

	/// Borrows the open file as a `BorrowedFd`.
	///
	/// # Errors
	///
	/// Returns an error if the operation is not supported for the underlying
	/// file type.
	#[cfg(unix)]
	pub fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, error::Error> {
		use std::os::fd::AsFd as _;

		match self {
			Self::Stdin(f, _) => Ok(f.as_fd()),
			Self::Stdout(f) => Ok(f.as_fd()),
			Self::Stderr(f) => Ok(f.as_fd()),
			Self::File(f, _) => Ok(f.as_fd()),
			Self::PipeReader(r, _) => Ok(r.as_fd()),
			Self::PipeWriter(w) => Ok(w.as_fd()),
			Self::Stream(s, _) => s.try_borrow_as_fd(),
		}
	}

	pub(crate) fn into_stdio(self) -> Result<Stdio, error::Error> {
		#[cfg(unix)]
		{
			let owned_fd = self.try_clone_to_owned()?;
			Ok(Stdio::from(std::fs::File::from(owned_fd)))
		}

		#[cfg(not(unix))]
		{
			let stdio = match self {
				Self::Stdin(..) => Stdio::inherit(),
				Self::Stdout(_) => Stdio::inherit(),
				Self::Stderr(_) => Stdio::inherit(),
				Self::File(f, _) => f.into(),
				Self::PipeReader(f, _) => f.into(),
				Self::PipeWriter(f) => f.into(),
				Self::Stream(..) => return Err(error::ErrorKind::CannotConvertToNativeFd.into()),
			};
			Ok(stdio)
		}
	}

	pub(crate) fn is_dir(&self) -> bool {
		match self {
			Self::Stdin(..) | Self::Stdout(_) | Self::Stderr(_) => false,
			Self::File(file, _) => file.metadata().is_ok_and(|m| m.is_dir()),
			Self::PipeReader(..) | Self::PipeWriter(_) | Self::Stream(..) => false,
		}
	}

	/// Checks if the open file is associated with a terminal.
	pub fn is_terminal(&self) -> bool {
		match self {
			Self::Stdin(f, _) => f.is_terminal(),
			Self::Stdout(f) => f.is_terminal(),
			Self::Stderr(f) => f.is_terminal(),
			Self::File(f, _) => f.is_terminal(),
			Self::Stream(stream, _) => stream.is_terminal(),
			Self::PipeReader(..) | Self::PipeWriter(_) => false,
		}
	}

	/// The input held for the next builtin read of this open file
	/// description; `None` for a write-only file.
	pub const fn held_input(&self) -> Option<&HeldInput> {
		match self {
			Self::Stdin(_, held) | Self::File(_, held) | Self::PipeReader(_, held) | Self::Stream(_, held) => {
				Some(held)
			},
			Self::Stdout(_) | Self::Stderr(_) | Self::PipeWriter(_) => None,
		}
	}
}

impl From<std::io::Stdin> for OpenFile {
	/// Creates an `OpenFile` from standard input.
	fn from(stdin: std::io::Stdin) -> Self {
		Self::Stdin(stdin, HeldInput::default())
	}
}

impl From<std::io::Stdout> for OpenFile {
	/// Creates an `OpenFile` from standard output.
	fn from(stdout: std::io::Stdout) -> Self {
		Self::Stdout(stdout)
	}
}

impl From<std::io::Stderr> for OpenFile {
	/// Creates an `OpenFile` from standard error.
	fn from(stderr: std::io::Stderr) -> Self {
		Self::Stderr(stderr)
	}
}

impl From<std::fs::File> for OpenFile {
	fn from(file: std::fs::File) -> Self {
		Self::File(file, HeldInput::default())
	}
}

impl From<std::io::PipeReader> for OpenFile {
	fn from(reader: std::io::PipeReader) -> Self {
		Self::PipeReader(reader, HeldInput::default())
	}
}

impl From<std::io::PipeWriter> for OpenFile {
	fn from(writer: std::io::PipeWriter) -> Self {
		Self::PipeWriter(writer)
	}
}

impl std::io::Read for OpenFile {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		match self {
			// Read fd 0 directly instead of through `std::io::Stdin`'s internal
			// `BufReader`: bytes buffered there but not consumed would be invisible to
			// raw-fd readiness polls and to child processes that inherit fd 0.
			#[cfg(unix)]
			Self::Stdin(f, _) => {
				use std::os::fd::AsFd as _;
				nix::unistd::read(f.as_fd(), buf).map_err(std::io::Error::from)
			},
			#[cfg(not(unix))]
			Self::Stdin(f, _) => f.read(buf),
			Self::Stdout(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stdout")))
			},
			Self::Stderr(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("stderr")))
			},
			Self::File(f, _) => f.read(buf),
			Self::PipeReader(reader, _) => reader.read(buf),
			Self::PipeWriter(_) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotReadable("pipe writer")))
			},
			Self::Stream(s, _) => s.read(buf),
		}
	}
}

impl std::io::Write for OpenFile {
	fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
		match self {
			Self::Stdin(..) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("stdin")))
			},
			Self::Stdout(f) => f.write(buf),
			Self::Stderr(f) => f.write(buf),
			Self::File(f, _) => f.write(buf),
			Self::PipeReader(..) => {
				Err(std::io::Error::other(error::ErrorKind::OpenFileNotWritable("pipe reader")))
			},
			Self::PipeWriter(writer) => writer.write(buf),
			Self::Stream(s, _) => s.write(buf),
		}
	}

	fn flush(&mut self) -> std::io::Result<()> {
		match self {
			Self::Stdin(..) => Ok(()),
			Self::Stdout(f) => f.flush(),
			Self::Stderr(f) => f.flush(),
			Self::File(f, _) => f.flush(),
			Self::PipeReader(..) => Ok(()),
			Self::PipeWriter(writer) => writer.flush(),
			Self::Stream(s, _) => s.flush(),
		}
	}
}

/// Tristate representing the an `OpenFile` entry in an `OpenFiles` structure.
pub enum OpenFileEntry<'a> {
	/// File descriptor is present and has a valid associated `OpenFile`.
	Open(&'a OpenFile),
	/// File descriptor is explicitly marked as not being mapped to any
	/// `OpenFile`.
	NotPresent,
	/// File descriptor is not specified in any way; it may be provided by a
	/// parent context of some kind.
	NotSpecified,
}

/// Represents the open files in a shell context.
#[derive(Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub struct OpenFiles {
	/// Maps shell file descriptors to open files.
	files: HashMap<ShellFd, Option<OpenFile>>,
}

impl OpenFiles {
	/// First file descriptor available for non-stdio files.
	const FIRST_NON_STDIO_FD: ShellFd = 3;
	/// Maximum file descriptor number allowed.
	const MAX_FD: ShellFd = 1024;
	/// File descriptor used for standard error.
	pub const STDERR_FD: ShellFd = 2;
	/// File descriptor used for standard input.
	pub const STDIN_FD: ShellFd = 0;
	/// File descriptor used for standard output.
	pub const STDOUT_FD: ShellFd = 1;

	/// Creates a new `OpenFiles` instance populated with stdin, stdout, and
	/// stderr from the host environment.
	pub(crate) fn new() -> Self {
		Self {
			files: HashMap::from([
				(Self::STDIN_FD, Some(std::io::stdin().into())),
				(Self::STDOUT_FD, Some(std::io::stdout().into())),
				(Self::STDERR_FD, Some(std::io::stderr().into())),
			]),
		}
	}

	/// Updates the open files from the provided iterator of (fd number,
	/// `OpenFile`) pairs. Any existing entries for the provided file
	/// descriptors will be overwritten.
	///
	/// # Arguments
	///
	/// * `files`: An iterator of (fd number, `OpenFile`) pairs to update the
	///   open files with.
	pub fn update_from(&mut self, files: impl Iterator<Item = (ShellFd, OpenFile)>) {
		for (fd, file) in files {
			let _ = self.files.insert(fd, Some(file));
		}
	}

	/// Retrieves the file backing standard input in this context.
	pub fn try_stdin(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDIN_FD).and_then(|f| f.as_ref())
	}

	/// Retrieves the file backing standard output in this context.
	pub fn try_stdout(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDOUT_FD).and_then(|f| f.as_ref())
	}

	/// Retrieves the file backing standard error in this context.
	pub fn try_stderr(&self) -> Option<&OpenFile> {
		self.files.get(&Self::STDERR_FD).and_then(|f| f.as_ref())
	}

	/// Tries to remove an open file by its file descriptor. If the file
	/// descriptor is not used, `None` will be returned; otherwise, the removed
	/// file will be returned.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to remove.
	pub fn remove_fd(&mut self, fd: ShellFd) -> Option<OpenFile> {
		self.files.insert(fd, None).and_then(|f| f)
	}

	/// Tries to lookup the `OpenFile` associated with a file descriptor.
	/// Returns `None` if the file descriptor is not present.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to lookup.
	pub fn try_fd(&self, fd: ShellFd) -> Option<&OpenFile> {
		self.files.get(&fd).and_then(|f| f.as_ref())
	}

	/// Tries to lookup the `OpenFile` associated with a file descriptor. Returns
	/// an `OpenFileEntry` representing the state of the file descriptor.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to lookup.
	pub fn fd_entry(&self, fd: ShellFd) -> OpenFileEntry<'_> {
		self
			.files
			.get(&fd)
			.map_or(OpenFileEntry::NotSpecified, |opt_file| match opt_file {
				Some(f) => OpenFileEntry::Open(f),
				None => OpenFileEntry::NotPresent,
			})
	}

	/// Checks if the given file descriptor is in use.
	pub fn contains_fd(&self, fd: ShellFd) -> bool {
		self.files.contains_key(&fd)
	}

	/// Associates the given file descriptor with the provided file. If the file
	/// descriptor is already in use, the previous file will be returned;
	/// otherwise, `None` will be returned.
	///
	/// Arguments:
	///
	/// * `fd`: The file descriptor to associate with the file.
	/// * `file`: The file to associate with the file descriptor.
	pub fn set_fd(&mut self, fd: ShellFd, file: OpenFile) -> Option<OpenFile> {
		self.files.insert(fd, Some(file)).and_then(|f| f)
	}

	/// Iterates over all file descriptors.
	pub fn iter_fds(&self) -> impl Iterator<Item = (ShellFd, &OpenFile)> {
		self
			.files
			.iter()
			.filter_map(|(fd, file)| file.as_ref().map(|f| (*fd, f)))
	}

	/// Adds a new open file, returning the assigned file descriptor.
	///
	/// # Arguments
	///
	/// * `file`: The open file to add.
	pub fn add(&mut self, file: OpenFile) -> Result<ShellFd, error::Error> {
		// Start searching for free file descriptors after the standard ones.
		let mut fd = Self::FIRST_NON_STDIO_FD;
		while self.files.contains_key(&fd) {
			if fd >= Self::MAX_FD {
				return Err(error::ErrorKind::TooManyOpenFiles.into());
			}

			fd += 1;
		}

		self.files.insert(fd, Some(file));
		Ok(fd)
	}
}

impl<I> From<I> for OpenFiles
where
	I: Iterator<Item = (ShellFd, OpenFile)>,
{
	fn from(iter: I) -> Self {
		let files = iter.map(|(fd, file)| (fd, Some(file))).collect();
		Self { files }
	}
}



#[cfg(test)]
#[cfg(unix)]
mod tests {
	use std::{
		io::{IsTerminal as _, Read as _, Write as _},
		os::fd::AsFd as _,
	};

	use anyhow::Result;

	use super::{HeldInput, OpenFile, Stream};

	struct TerminalStream(std::fs::File);

	impl std::io::Read for TerminalStream {
		fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
			self.0.read(buf)
		}
	}

	impl std::io::Write for TerminalStream {
		fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
			self.0.write(buf)
		}

		fn flush(&mut self) -> std::io::Result<()> {
			self.0.flush()
		}
	}

	impl Stream for TerminalStream {
		fn clone_box(&self) -> Box<dyn Stream> {
			Box::new(Self(self.0.try_clone().expect("clone pty stream")))
		}

		fn is_terminal(&self) -> bool {
			self.0.is_terminal()
		}

		fn try_clone_to_owned(&self) -> Result<std::os::fd::OwnedFd, crate::error::Error> {
			Ok(self.0.as_fd().try_clone_to_owned()?)
		}

		fn try_borrow_as_fd(&self) -> Result<std::os::fd::BorrowedFd<'_>, crate::error::Error> {
			Ok(self.0.as_fd())
		}
	}

	const CHILD_ENV: &str = "BRUSH_OPENFILE_STDIN_CHILD";
	const TEST_NAME: &str = "openfiles::tests::stdin_read_leaves_unread_bytes_on_fd0";

	#[test]
	fn stdin_read_leaves_unread_bytes_on_fd0() -> Result<()> {
		if std::env::var_os(CHILD_ENV).is_some() {
			// Child: take one byte through `OpenFile::Stdin`, then read the rest from a
			// duplicate of fd 0, the way a forked command inheriting stdin would.
			let mut stdin = OpenFile::from(std::io::stdin());
			let mut first = [0u8; 1];
			stdin.read_exact(&mut first)?;

			let mut raw = std::fs::File::from(stdin.try_clone_to_owned()?);
			let mut rest = String::new();
			raw.read_to_string(&mut rest)?;

			println!("first={} rest={rest}", char::from(first[0]));
			return Ok(());
		}

		let mut child = std::process::Command::new(std::env::current_exe()?)
			.args(["--exact", TEST_NAME, "--nocapture", "--test-threads=1"])
			.env(CHILD_ENV, "1")
			.stdin(std::process::Stdio::piped())
			.stdout(std::process::Stdio::piped())
			.spawn()?;
		if let Some(mut pipe) = child.stdin.take() {
			pipe.write_all(b"abcdef")?;
		}
		let output = child.wait_with_output()?;
		anyhow::ensure!(output.status.success(), "child test run failed: {:?}", output.status);

		let stdout = String::from_utf8_lossy(&output.stdout);
		anyhow::ensure!(stdout.contains("first=a rest=bcdef"), "unexpected child output: {stdout}");
		Ok(())
	}

	#[test]
	fn terminal_backed_custom_stream_is_terminal() -> Result<()> {
		let pty = nix::pty::openpty(None, None)?;
		let stream = OpenFile::Stream(Box::new(TerminalStream(std::fs::File::from(pty.slave))), HeldInput::default());
		assert!(stream.is_terminal());
		Ok(())
	}
}
