//! Descriptor-pinned file access beneath a `--confine` session root.
//!
//! A pathname check followed by a pathname open is a TOCTOU window: a process
//! inside the root can swap a parent directory for a symlink that points
//! outside it after the check and before the open. These helpers never resolve
//! a pathname below the root. They open the root once, then walk every
//! component with `openat(..., O_NOFOLLOW)`. The final read or write uses
//! descriptors from that walk, so a symlink anywhere below the root fails the
//! operation instead of redirecting it.
//!
//! Errors carry a stable `confine:<reason>` prefix that the TypeScript caller
//! maps to filesystem error codes.

#[cfg(not(unix))]
use napi::Error;
use napi::{Result, bindgen_prelude::Buffer};
use napi_derive::napi;

/// Open `relative` beneath `root` for reading and return an owned descriptor.
///
/// `relative` must be a normalized relative path with no `..` component. A
/// symlink at any component below `root` is rejected. The caller owns the
/// returned descriptor and must close it.
#[napi]
pub fn confined_open_read(root: String, relative: String) -> Result<i32> {
	#[cfg(unix)]
	{
		unix::open_read(&root, &relative).map_err(unix::to_napi)
	}
	#[cfg(not(unix))]
	{
		let _ = (root, relative);
		Err(Error::from_reason("confine:unsupported: confined file access requires a Unix host"))
	}
}

/// Atomically replace or create `relative` beneath `root` with `data`.
///
/// The bytes are staged in an exclusively created sibling temp file opened
/// through the pinned parent descriptor, synced, and published with
/// `renameat` against that same descriptor. An existing target keeps its
/// mode. A symlinked, hard-linked, or non-regular target is rejected. Missing
/// parent directories are created only when `create_parents` is set.
#[napi]
pub fn confined_write_file_atomic(
	root: String,
	relative: String,
	data: Buffer,
	create_parents: bool,
) -> Result<()> {
	#[cfg(unix)]
	{
		unix::write_atomic(&root, &relative, &data, create_parents).map_err(unix::to_napi)
	}
	#[cfg(not(unix))]
	{
		let _ = (root, relative, data, create_parents);
		Err(Error::from_reason("confine:unsupported: confined file access requires a Unix host"))
	}
}

/// Remove the file `relative` beneath `root` through the pinned parent
/// descriptor.
#[napi]
pub fn confined_unlink(root: String, relative: String) -> Result<()> {
	#[cfg(unix)]
	{
		unix::unlink(&root, &relative).map_err(unix::to_napi)
	}
	#[cfg(not(unix))]
	{
		let _ = (root, relative);
		Err(Error::from_reason("confine:unsupported: confined file access requires a Unix host"))
	}
}

/// Create `relative` and any missing ancestors beneath `root` without following
/// a symlink at any component.
#[napi]
pub fn confined_mkdir_all(root: String, relative: String) -> Result<()> {
	#[cfg(unix)]
	{
		unix::mkdir_all(&root, &relative).map_err(unix::to_napi)
	}
	#[cfg(not(unix))]
	{
		let _ = (root, relative);
		Err(Error::from_reason("confine:unsupported: confined file access requires a Unix host"))
	}
}

#[cfg(unix)]
mod unix {
	use std::{
		ffi::CString,
		io,
		os::unix::ffi::OsStrExt,
		path::{Component, Path},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use napi::Error;

	const TEMP_CREATE_ATTEMPTS: u32 = 8;
	const DEFAULT_FILE_MODE: libc::mode_t = 0o666;
	const DIRECTORY_MODE: libc::mode_t = 0o777;
	static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

	pub enum ConfineError {
		/// A component below the root is a symlink or the path is not normalized.
		Escape,
		NotFound,
		IsDirectory,
		NotDirectory,
		NotFile,
		HardLinked,
		Io(io::Error),
	}

	pub fn to_napi(error: ConfineError) -> Error {
		let message = match error {
			ConfineError::Escape => "confine:escape: path leaves the confined session root".to_owned(),
			ConfineError::NotFound => "confine:not_found: no such file or directory".to_owned(),
			ConfineError::IsDirectory => "confine:is_directory: path is a directory".to_owned(),
			ConfineError::NotDirectory => {
				"confine:not_directory: a parent component is not a directory".to_owned()
			},
			ConfineError::NotFile => "confine:not_file: path is not a regular file".to_owned(),
			ConfineError::HardLinked => {
				"confine:hard_linked: replacement would split a hard-linked file".to_owned()
			},
			ConfineError::Io(err) => {
				let code = err.raw_os_error().unwrap_or(0);
				let reason = match code {
					libc::EACCES | libc::EPERM => "permission_denied",
					libc::EROFS => "read_only",
					_ => "io",
				};
				format!("confine:{reason}: {err}")
			},
		};
		Error::from_reason(message)
	}

	fn last_os_error() -> ConfineError {
		classify(io::Error::last_os_error())
	}

	fn classify(err: io::Error) -> ConfineError {
		match err.raw_os_error() {
			Some(libc::ENOENT) => ConfineError::NotFound,
			// O_NOFOLLOW on a symlink reports ELOOP; O_DIRECTORY|O_NOFOLLOW on a
			// symlink reports ENOTDIR on some kernels, so it is checked by lstat
			// before the open instead of being read from the errno here.
			Some(libc::ELOOP) => ConfineError::Escape,
			Some(libc::EISDIR) => ConfineError::IsDirectory,
			Some(libc::ENOTDIR) => ConfineError::NotDirectory,
			_ => ConfineError::Io(err),
		}
	}

	/// Owned descriptor closed on drop.
	struct Fd(libc::c_int);

	impl Fd {
		const fn into_raw(self) -> libc::c_int {
			let fd = self.0;
			std::mem::forget(self);
			fd
		}
	}

	impl Drop for Fd {
		fn drop(&mut self) {
			// SAFETY: self owns this live descriptor and closes it exactly once.
			unsafe { libc::close(self.0) };
		}
	}

	fn c_name(segment: &[u8]) -> Result<CString, ConfineError> {
		CString::new(segment).map_err(|_| ConfineError::Escape)
	}

	/// Split a caller-supplied relative path into normal components.
	fn components(relative: &str) -> Result<Vec<CString>, ConfineError> {
		let path = Path::new(relative);
		if path.is_absolute() {
			return Err(ConfineError::Escape);
		}
		let mut names = Vec::new();
		for component in path.components() {
			match component {
				Component::Normal(segment) => names.push(c_name(segment.as_bytes())?),
				Component::CurDir => {},
				Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
					return Err(ConfineError::Escape);
				},
			}
		}
		Ok(names)
	}

	fn lstat_at(dir: &Fd, name: &CString) -> Result<libc::stat, ConfineError> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut st: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: dir is live, name is NUL-terminated, and st is writable.
		if unsafe { libc::fstatat(dir.0, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
			return Err(last_os_error());
		}
		Ok(st)
	}

	fn fstat(fd: &Fd) -> Result<libc::stat, ConfineError> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut st: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: fd is live and st is writable.
		if unsafe { libc::fstat(fd.0, &mut st) } != 0 {
			return Err(last_os_error());
		}
		Ok(st)
	}

	const fn file_type(st: &libc::stat) -> libc::mode_t {
		st.st_mode & libc::S_IFMT
	}

	fn open_root(root: &str) -> Result<Fd, ConfineError> {
		let root = CString::new(root.as_bytes()).map_err(|_| ConfineError::Escape)?;
		// The root is the session's own cwd, fixed at launch. It is opened by
		// pathname once; everything below it is resolved through descriptors.
		// SAFETY: root is NUL-terminated and the flags request a directory descriptor.
		let fd =
			unsafe { libc::open(root.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
		if fd < 0 {
			return Err(last_os_error());
		}
		Ok(Fd(fd))
	}

	fn open_dir_at(dir: &Fd, name: &CString) -> Result<Fd, ConfineError> {
		let st = lstat_at(dir, name)?;
		match file_type(&st) {
			libc::S_IFDIR => {},
			libc::S_IFLNK => return Err(ConfineError::Escape),
			_ => return Err(ConfineError::NotDirectory),
		}
		// SAFETY: dir is live and name is NUL-terminated. O_NOFOLLOW makes a
		// component swapped for a symlink after the lstat fail with ELOOP/ENOTDIR.
		let fd = unsafe {
			libc::openat(
				dir.0,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if fd < 0 {
			let err = io::Error::last_os_error();
			return Err(if err.raw_os_error() == Some(libc::ENOTDIR) {
				ConfineError::Escape
			} else {
				classify(err)
			});
		}
		let opened = Fd(fd);
		let current = fstat(&opened)?;
		if current.st_dev != st.st_dev || current.st_ino != st.st_ino {
			return Err(ConfineError::Escape);
		}
		Ok(opened)
	}

	fn mkdir_at(dir: &Fd, name: &CString) -> Result<(), ConfineError> {
		// SAFETY: dir is live and name is NUL-terminated. mkdirat never follows
		// a symlink at the final component; an existing entry reports EEXIST.
		if unsafe { libc::mkdirat(dir.0, name.as_ptr(), DIRECTORY_MODE) } != 0 {
			let err = io::Error::last_os_error();
			if err.raw_os_error() != Some(libc::EEXIST) {
				return Err(classify(err));
			}
		}
		Ok(())
	}

	/// Walk every directory component of `names` below `root`.
	fn walk_parents(root: Fd, names: &[CString], create: bool) -> Result<Fd, ConfineError> {
		let mut dir = root;
		for name in names {
			dir = match open_dir_at(&dir, name) {
				Ok(next) => next,
				Err(ConfineError::NotFound) if create => {
					mkdir_at(&dir, name)?;
					open_dir_at(&dir, name)?
				},
				Err(error) => return Err(error),
			};
		}
		Ok(dir)
	}

	fn split_leaf(relative: &str) -> Result<(Vec<CString>, CString), ConfineError> {
		let mut names = components(relative)?;
		let leaf = names.pop().ok_or(ConfineError::IsDirectory)?;
		Ok((names, leaf))
	}

	pub fn open_read(root: &str, relative: &str) -> Result<i32, ConfineError> {
		let (parents, leaf) = split_leaf(relative)?;
		let dir = walk_parents(open_root(root)?, &parents, false)?;
		let st = lstat_at(&dir, &leaf)?;
		match file_type(&st) {
			libc::S_IFREG => {},
			libc::S_IFLNK => return Err(ConfineError::Escape),
			libc::S_IFDIR => return Err(ConfineError::IsDirectory),
			_ => return Err(ConfineError::NotFile),
		}
		// SAFETY: dir is live and leaf is NUL-terminated. O_NONBLOCK keeps a FIFO
		// swapped in after the lstat from blocking the open.
		let fd = unsafe {
			libc::openat(
				dir.0,
				leaf.as_ptr(),
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if fd < 0 {
			return Err(last_os_error());
		}
		let opened = Fd(fd);
		let current = fstat(&opened)?;
		if file_type(&current) != libc::S_IFREG
			|| current.st_dev != st.st_dev
			|| current.st_ino != st.st_ino
		{
			return Err(ConfineError::Escape);
		}
		// Reads use the descriptor in blocking mode.
		// SAFETY: opened is live; F_GETFL/F_SETFL only change status flags.
		unsafe {
			let flags = libc::fcntl(opened.0, libc::F_GETFL);
			if flags >= 0 {
				libc::fcntl(opened.0, libc::F_SETFL, flags & !libc::O_NONBLOCK);
			}
		}
		Ok(opened.into_raw())
	}

	pub fn unlink(root: &str, relative: &str) -> Result<(), ConfineError> {
		let (parents, leaf) = split_leaf(relative)?;
		let dir = walk_parents(open_root(root)?, &parents, false)?;
		if file_type(&lstat_at(&dir, &leaf)?) == libc::S_IFDIR {
			return Err(ConfineError::IsDirectory);
		}
		// SAFETY: dir is live and leaf is NUL-terminated. unlinkat removes the
		// entry itself and never follows a symlink at the final component.
		if unsafe { libc::unlinkat(dir.0, leaf.as_ptr(), 0) } != 0 {
			return Err(last_os_error());
		}
		Ok(())
	}

	pub fn mkdir_all(root: &str, relative: &str) -> Result<(), ConfineError> {
		walk_parents(open_root(root)?, &components(relative)?, true).map(drop)
	}

	fn temp_name(leaf: &CString) -> Result<CString, ConfineError> {
		let nanos = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_nanos());
		let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
		let mut name = Vec::with_capacity(leaf.as_bytes().len() + 48);
		name.push(b'.');
		name.extend_from_slice(leaf.as_bytes());
		name.extend_from_slice(
			format!(".{}.{nanos:x}.{counter}.gjc-confine.tmp", std::process::id()).as_bytes(),
		);
		c_name(&name)
	}

	fn write_all(fd: &Fd, data: &[u8]) -> Result<(), ConfineError> {
		let mut written = 0;
		while written < data.len() {
			let rest = &data[written..];
			// SAFETY: fd is live and rest points to rest.len() readable bytes.
			let count = unsafe { libc::write(fd.0, rest.as_ptr().cast(), rest.len()) };
			if count < 0 {
				let err = io::Error::last_os_error();
				if err.kind() == io::ErrorKind::Interrupted {
					continue;
				}
				return Err(ConfineError::Io(err));
			}
			written += count as usize;
		}
		Ok(())
	}

	fn unlink_at(dir: &Fd, name: &CString) {
		// SAFETY: dir is live and name is NUL-terminated; cleanup is best effort.
		unsafe { libc::unlinkat(dir.0, name.as_ptr(), 0) };
	}

	/// Existing target metadata, or `None` when the target does not exist.
	fn existing_target(dir: &Fd, leaf: &CString) -> Result<Option<libc::stat>, ConfineError> {
		let st = match lstat_at(dir, leaf) {
			Ok(st) => st,
			Err(ConfineError::NotFound) => return Ok(None),
			Err(error) => return Err(error),
		};
		match file_type(&st) {
			libc::S_IFREG => {},
			libc::S_IFLNK => return Err(ConfineError::Escape),
			libc::S_IFDIR => return Err(ConfineError::IsDirectory),
			_ => return Err(ConfineError::NotFile),
		}
		if st.st_nlink > 1 {
			return Err(ConfineError::HardLinked);
		}
		// rename(2) ignores the target's own permission bits. Opening it for
		// writing (without truncation) keeps a read-only file read-only.
		// SAFETY: dir is live and leaf is NUL-terminated.
		let probe = unsafe {
			libc::openat(
				dir.0,
				leaf.as_ptr(),
				libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if probe < 0 {
			return Err(last_os_error());
		}
		drop(Fd(probe));
		Ok(Some(st))
	}

	fn same_target(
		dir: &Fd,
		leaf: &CString,
		expected: Option<&libc::stat>,
	) -> Result<bool, ConfineError> {
		match (lstat_at(dir, leaf), expected) {
			(Err(ConfineError::NotFound), None) => Ok(true),
			(Ok(_), None) | (Err(ConfineError::NotFound), Some(_)) => Ok(false),
			(Ok(current), Some(expected)) => Ok(file_type(&current) == libc::S_IFREG
				&& current.st_dev == expected.st_dev
				&& current.st_ino == expected.st_ino),
			(Err(error), _) => Err(error),
		}
	}

	pub fn write_atomic(
		root: &str,
		relative: &str,
		data: &[u8],
		create_parents: bool,
	) -> Result<(), ConfineError> {
		let (parents, leaf) = split_leaf(relative)?;
		let dir = walk_parents(open_root(root)?, &parents, create_parents)?;
		let existing = existing_target(&dir, &leaf)?;
		let mode = existing
			.as_ref()
			.map_or(DEFAULT_FILE_MODE, |st| st.st_mode & 0o7777);
		for _ in 0..TEMP_CREATE_ATTEMPTS {
			let tmp = temp_name(&leaf)?;
			// SAFETY: dir is live and tmp is NUL-terminated. O_EXCL|O_NOFOLLOW never
			// reuses or follows a pre-existing entry.
			let fd = unsafe {
				libc::openat(
					dir.0,
					tmp.as_ptr(),
					libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					libc::c_uint::from(mode),
				)
			};
			if fd < 0 {
				let err = io::Error::last_os_error();
				if err.raw_os_error() == Some(libc::EEXIST) {
					continue;
				}
				return Err(classify(err));
			}
			let staged = Fd(fd);
			let result = (|| {
				write_all(&staged, data)?;
				if existing.is_some() {
					// SAFETY: staged is live; restores the target mode the umask masked.
					if unsafe { libc::fchmod(staged.0, mode) } != 0 {
						return Err(last_os_error());
					}
				}
				// SAFETY: staged is live.
				if unsafe { libc::fsync(staged.0) } != 0 {
					return Err(last_os_error());
				}
				if !same_target(&dir, &leaf, existing.as_ref())? {
					return Err(ConfineError::Io(io::Error::other(
						"destination was replaced while staging; refusing to overwrite a different file",
					)));
				}
				// SAFETY: dir is live and both names are NUL-terminated entries of it.
				if unsafe { libc::renameat(dir.0, tmp.as_ptr(), dir.0, leaf.as_ptr()) } != 0 {
					return Err(last_os_error());
				}
				Ok(())
			})();
			drop(staged);
			if result.is_err() {
				unlink_at(&dir, &tmp);
			}
			return result;
		}
		Err(ConfineError::Io(io::Error::from_raw_os_error(libc::EEXIST)))
	}
}
