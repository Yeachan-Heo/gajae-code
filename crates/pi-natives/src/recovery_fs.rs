//! Linux-only descriptor-relative filesystem authority for crash recovery.
//!
//! Every operation is rooted in the directory descriptor acquired by
//! [`open_recovery_fs_root`]. Relative names are walked one component at a
//! time without following symlinks, and regular files must be single-linked.

use std::{
	ffi::CString,
	fs::File,
	io::{Read, Write},
	path::{Component, Path},
};

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
use parking_lot::Mutex;

const MAX_CONTENT_BYTES: u64 = 1024 * 1024;

#[napi(object)]
pub struct RecoveryFsIdentity {
	pub dev:      String,
	pub ino:      String,
	pub size:     String,
	pub mtime_ns: String,
}

#[napi(object)]
pub struct RecoveryFsResult {
	pub ok:       bool,
	pub code:     Option<String>,
	pub identity: Option<RecoveryFsIdentity>,
	pub data:     Option<Uint8Array>,
}

impl RecoveryFsResult {
	const fn success(identity: RecoveryFsIdentity) -> Self {
		Self { ok: true, code: None, identity: Some(identity), data: None }
	}

	fn data(identity: RecoveryFsIdentity, data: Vec<u8>) -> Self {
		Self {
			ok:       true,
			code:     None,
			identity: Some(identity),
			data:     Some(Uint8Array::from(data)),
		}
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()), identity: None, data: None }
	}
}

/// Retained trusted-root authority for Linux recovery artifacts.
#[napi]
pub struct RecoveryFsRoot {
	#[cfg(target_os = "linux")]
	root: Mutex<Option<File>>,
}

#[napi]
impl RecoveryFsRoot {
	/// Return the stable identity of the retained root descriptor.
	#[napi]
	pub fn identity(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			self.root.lock().as_ref().map_or_else(
				|| RecoveryFsResult::failure("closed"),
				|root| identity(root).map_or_else(RecoveryFsResult::failure, RecoveryFsResult::success),
			)
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsResult::failure("unsupported_platform")
	}

	/// Stat one existing regular, single-linked file without following links.
	#[napi]
	pub fn stat(&self, relative_path: String) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				let file = open_existing(root, &relative_path, false)?;
				regular_identity(&file).map(RecoveryFsResult::success)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = relative_path;
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Read one existing regular, single-linked file without following links.
	#[napi]
	pub fn read(&self, relative_path: String, max_bytes: u32) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				let max_bytes = u64::from(max_bytes).min(MAX_CONTENT_BYTES);
				let file = open_existing(root, &relative_path, false)?;
				let identity = regular_identity(&file)?;
				if identity
					.size
					.parse::<u64>()
					.ok()
					.is_none_or(|size| size > max_bytes)
				{
					return Err("content_too_large");
				}
				let mut file = file;
				let mut data = Vec::with_capacity(identity.size.parse::<usize>().unwrap_or(0));
				file.read_to_end(&mut data).map_err(|_| "io_error")?;
				if data.len() as u64 > max_bytes || regular_identity(&file)?.ino != identity.ino {
					return Err("identity_mismatch");
				}
				Ok(RecoveryFsResult::data(identity, data))
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, max_bytes);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Create one previously absent regular, owner-only file and synchronously
	/// persist its contents. Existing entries are never replaced.
	#[napi]
	pub fn create(&self, relative_path: String, data: Uint8Array) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| create(root, &relative_path, data.as_ref()))
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, data);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Atomically install an already-created regular file at an absent name.
	/// Both names remain relative to this retained root and are never resolved
	/// through a pathname after their parent descriptors are acquired.
	#[napi]
	pub fn install(
		&self,
		source_relative_path: String,
		destination_relative_path: String,
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				install(root, &source_relative_path, &destination_relative_path)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (source_relative_path, destination_relative_path);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Synchronize the retained root directory, making a preceding create or
	/// install durable when the filesystem supports directory fsync.
	#[napi]
	pub fn fsync(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				root.sync_all().map_err(|_| "fsync_failed")?;
				identity(root).map(RecoveryFsResult::success)
			})
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsResult::failure("unsupported_platform")
	}

	#[napi]
	pub fn close(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			let mut root = self.root.lock();
			let Some(root) = root.take() else {
				return RecoveryFsResult::failure("closed");
			};
			identity(&root).map_or_else(RecoveryFsResult::failure, RecoveryFsResult::success)
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsResult::failure("unsupported_platform")
	}
}

/// Acquire an immutable trusted-root descriptor. Linux is required; every
/// other platform returns a durable unsupported-platform result.
#[napi]
pub fn open_recovery_fs_root(path: String) -> napi::Result<RecoveryFsRoot> {
	#[cfg(target_os = "linux")]
	{
		let root = open_root(Path::new(&path)).map_err(napi::Error::from_reason)?;
		Ok(RecoveryFsRoot { root: Mutex::new(Some(root)) })
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		Err(napi::Error::from_reason("unsupported_platform"))
	}
}

#[cfg(target_os = "linux")]
fn with_root(
	root: &Mutex<Option<File>>,
	operation: impl FnOnce(&File) -> Result<RecoveryFsResult, &'static str>,
) -> RecoveryFsResult {
	let guard = root.lock();
	guard.as_ref().map_or_else(
		|| RecoveryFsResult::failure("closed"),
		|root| operation(root).unwrap_or_else(RecoveryFsResult::failure),
	)
}

#[cfg(target_os = "linux")]
fn stat_mtime_ns(stat: &libc::stat) -> i128 {
	i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtime_nsec)
}

#[cfg(target_os = "linux")]
fn identity(file: &File) -> Result<RecoveryFsIdentity, &'static str> {
	use std::os::fd::AsRawFd;
	// SAFETY: `libc::stat` may be zero-initialized before `fstat` fills its output
	// storage.
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `file` owns a valid fd and `stat` is valid writable output storage
	// for `fstat`.
	if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } != 0 {
		return Err("io_error");
	}
	Ok(RecoveryFsIdentity {
		dev:      stat.st_dev.to_string(),
		ino:      stat.st_ino.to_string(),
		size:     (stat.st_size as u64).to_string(),
		mtime_ns: stat_mtime_ns(&stat).to_string(),
	})
}

#[cfg(target_os = "linux")]
fn regular_identity(file: &File) -> Result<RecoveryFsIdentity, &'static str> {
	use std::os::fd::AsRawFd;
	// SAFETY: `libc::stat` may be zero-initialized before `fstat` fills its output
	// storage.
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `file` owns a valid fd and `stat` is valid writable output storage
	// for `fstat`.
	if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } != 0 {
		return Err("io_error");
	}
	if stat.st_mode & libc::S_IFMT != libc::S_IFREG {
		return Err("not_regular_file");
	}
	if stat.st_nlink != 1 {
		return Err("hard_link");
	}
	Ok(RecoveryFsIdentity {
		dev:      stat.st_dev.to_string(),
		ino:      stat.st_ino.to_string(),
		size:     (stat.st_size as u64).to_string(),
		mtime_ns: stat_mtime_ns(&stat).to_string(),
	})
}

#[cfg(target_os = "linux")]
fn segments(relative_path: &str) -> Result<Vec<CString>, &'static str> {
	let path = Path::new(relative_path);
	if path.is_absolute() || relative_path.contains('\0') {
		return Err("invalid_path");
	}
	let mut names = Vec::new();
	for component in path.components() {
		match component {
			Component::Normal(name) => {
				names.push(CString::new(name.as_encoded_bytes()).map_err(|_| "invalid_path")?);
			},
			Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err("invalid_path");
			},
		}
	}
	if names.is_empty() {
		Err("invalid_path")
	} else {
		Ok(names)
	}
}

#[cfg(target_os = "linux")]
fn open_root(path: &Path) -> Result<File, String> {
	use std::os::{fd::FromRawFd, unix::ffi::OsStrExt};
	if !path.is_absolute() {
		return Err("invalid_path".to_owned());
	}
	let mut fd =
	// SAFETY: the static C string is NUL-terminated and remains valid for this call.
		unsafe { libc::open(c"/".as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
	if fd < 0 {
		return Err("io_error".to_owned());
	}
	for component in path.components() {
		let Component::Normal(name) = component else {
			continue;
		};
		let name = CString::new(name.as_bytes()).map_err(|_| "invalid_path".to_owned())?;
		// SAFETY: `libc::stat` may be zero-initialized before `fstatat` fills its
		// output storage.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `fd` is open, `name` remains NUL-terminated and live, and `named` is
		// writable output storage.
		if unsafe { libc::fstatat(fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) } != 0
			|| named.st_mode & libc::S_IFMT == libc::S_IFLNK
		{
			// SAFETY: `fd` is the currently owned open descriptor and is not used after
			// this close.
			unsafe { libc::close(fd) };
			return Err("untrusted_root".to_owned());
		}
		// SAFETY: `fd` is open and `name` is a live NUL-terminated path component for
		// the duration of the call.
		let next = unsafe {
			libc::openat(
				fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		// SAFETY: `fd` is the currently owned open descriptor and `next` has already
		// received any replacement fd.
		unsafe { libc::close(fd) };
		if next < 0 {
			return Err("untrusted_root".to_owned());
		}
		// SAFETY: `libc::stat` may be zero-initialized before `fstat` fills its output
		// storage.
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `next` is an open fd and `opened` is valid writable output storage
		// for `fstat`.
		if unsafe { libc::fstat(next, &mut opened) } != 0
			|| opened.st_mode & libc::S_IFMT != libc::S_IFDIR
			|| opened.st_dev != named.st_dev
			|| opened.st_ino != named.st_ino
		{
			// SAFETY: `next` is the currently owned open descriptor and is not used after
			// this close.
			unsafe { libc::close(next) };
			return Err("untrusted_root".to_owned());
		}
		fd = next;
	}
	// SAFETY: `fd` is an owned open descriptor whose ownership is transferred
	// exactly once to `File`.
	Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn open_parent(root: &File, relative_path: &str) -> Result<(File, CString), &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd};
	let names = segments(relative_path)?;
	let (name, ancestors) = names.split_last().ok_or("invalid_path")?;
	// SAFETY: `root` owns a valid fd; `dup` returns an independently owned
	// descriptor on success.
	let mut fd = unsafe { libc::dup(root.as_raw_fd()) };
	if fd < 0 {
		return Err("io_error");
	}
	for ancestor in ancestors {
		// SAFETY: `libc::stat` may be zero-initialized before `fstatat` fills its
		// output storage.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `fd` is open, `ancestor` remains NUL-terminated and live, and `named`
		// is writable output storage.
		if unsafe { libc::fstatat(fd, ancestor.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) } != 0
			|| named.st_mode & libc::S_IFMT != libc::S_IFDIR
		{
			// SAFETY: `fd` is the currently owned open descriptor and is not used after
			// this close.
			unsafe { libc::close(fd) };
			return Err("reparse_point");
		}
		// SAFETY: `fd` is open and `ancestor` is a live NUL-terminated path component
		// for the duration of the call.
		let next = unsafe {
			libc::openat(
				fd,
				ancestor.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		// SAFETY: `fd` is the currently owned open descriptor and `next` has already
		// received any replacement fd.
		unsafe { libc::close(fd) };
		if next < 0 {
			return Err("reparse_point");
		}
		// SAFETY: `libc::stat` may be zero-initialized before `fstat` fills its output
		// storage.
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `next` is an open fd and `opened` is valid writable output storage
		// for `fstat`.
		if unsafe { libc::fstat(next, &mut opened) } != 0
			|| opened.st_mode & libc::S_IFMT != libc::S_IFDIR
			|| opened.st_dev != named.st_dev
			|| opened.st_ino != named.st_ino
		{
			// SAFETY: `next` is the currently owned open descriptor and is not used after
			// this close.
			unsafe { libc::close(next) };
			return Err("identity_mismatch");
		}
		fd = next;
	}
	// SAFETY: `fd` is an owned open descriptor whose ownership is transferred
	// exactly once to `File`.
	Ok((unsafe { File::from_raw_fd(fd) }, name.clone()))
}

#[cfg(target_os = "linux")]
fn open_existing(root: &File, relative_path: &str, writable: bool) -> Result<File, &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd};
	let (parent, name) = open_parent(root, relative_path)?;
	// SAFETY: `libc::stat` may be zero-initialized before `fstatat` fills its
	// output storage.
	let mut named: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `parent` owns a valid fd, `name` is live and NUL-terminated, and
	// `named` is writable output storage.
	if unsafe {
		libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
	} != 0
	{
		return Err("not_found");
	}
	if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
		return Err("reparse_point");
	}
	if named.st_mode & libc::S_IFMT != libc::S_IFREG {
		return Err("not_regular_file");
	}
	if named.st_nlink != 1 {
		return Err("hard_link");
	}
	let flags = libc::O_CLOEXEC
		| libc::O_NOFOLLOW
		| if writable {
			libc::O_RDWR
		} else {
			libc::O_RDONLY
		};
	// SAFETY: `parent` owns a valid fd and `name` is a live NUL-terminated path for
	// the duration of the call.
	let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
	if fd < 0 {
		return Err("io_error");
	}
	// SAFETY: `fd` is an owned open descriptor whose ownership is transferred
	// exactly once to `File`.
	let file = unsafe { File::from_raw_fd(fd) };
	let actual = regular_identity(&file)?;
	if actual.dev != named.st_dev.to_string() || actual.ino != named.st_ino.to_string() {
		return Err("identity_mismatch");
	}
	Ok(file)
}

#[cfg(target_os = "linux")]
fn create(root: &File, relative_path: &str, data: &[u8]) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd};
	if data.len() as u64 > MAX_CONTENT_BYTES {
		return Err("content_too_large");
	}
	let (parent, name) = open_parent(root, relative_path)?;
	// SAFETY: `parent` owns a valid fd and `name` is a live NUL-terminated path for
	// the duration of the call.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			name.as_ptr(),
			libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			0o600,
		)
	};
	if fd < 0 {
		return Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::EEXIST) => "already_exists",
			_ => "io_error",
		});
	}
	// SAFETY: `fd` is an owned open descriptor whose ownership is transferred
	// exactly once to `File`.
	let mut file = unsafe { File::from_raw_fd(fd) };
	file.write_all(data).map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	let identity = regular_identity(&file)?;
	// SAFETY: `libc::stat` may be zero-initialized before `fstatat` fills its
	// output storage.
	let mut named: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: `parent` owns a valid fd, `name` is live and NUL-terminated, and
	// `named` is writable output storage.
	if unsafe {
		libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
	} != 0
		|| identity.dev != named.st_dev.to_string()
		|| identity.ino != named.st_ino.to_string()
	{
		return Err("identity_mismatch");
	}
	Ok(RecoveryFsResult::success(identity))
}

#[cfg(target_os = "linux")]
fn install(root: &File, source: &str, destination: &str) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::AsRawFd;
	let source_file = open_existing(root, source, false)?;
	let source_identity = regular_identity(&source_file)?;
	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	// SAFETY: both parents own valid fds and both names are live NUL-terminated
	// strings for this syscall.
	let result = unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			source_parent.as_raw_fd(),
			source_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			libc::RENAME_NOREPLACE,
		)
	};
	if result != 0 {
		return Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::EEXIST) => "already_exists",
			Some(libc::ENOSYS | libc::EINVAL) => "atomic_unavailable",
			_ => "io_error",
		});
	}
	let installed = open_existing(root, destination, false)?;
	let installed_identity = regular_identity(&installed)?;
	if installed_identity.dev != source_identity.dev || installed_identity.ino != source_identity.ino
	{
		return Err("identity_mismatch");
	}
	destination_parent.sync_all().map_err(|_| "fsync_failed")?;
	Ok(RecoveryFsResult::success(installed_identity))
}
