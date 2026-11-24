// Adapted from oh-my-pi (MIT) crates/natives/src/file_lock/unix.rs @
// 31ffee513f27a01bba7d4dfbe12bae239cdc646a Modified for gajae-code: the
// sidecar opens with O_NOFOLLOW and O_NONBLOCK and must be a regular,
// single-link file this user owns with no group or other permission bits;
// errors are classified where they occur (only ENOLCK and ENOTSUP/EOPNOTSUPP
// are unavailable); EINTR is retried; built for Linux and macOS only.

//! Sidecar locks: an open-file-description record lock on Linux, `flock(2)`
//! on macOS.
//!
//! Neither kind is dropped when the process closes some other descriptor of
//! the same file, so a probe never releases a lock its own process holds.

use std::{
	ffi::CStr,
	fs::File,
	io,
	os::{
		fd::{AsRawFd, FromRawFd},
		unix::fs::MetadataExt,
	},
};

use super::{Fault, FileLockFailure};

const SIDECAR_MODE: libc::c_uint = 0o600;

#[cfg(target_os = "linux")]
#[allow(
	clippy::cast_possible_truncation,
	reason = "Linux declares lock types as c_int; the values fit flock.l_type"
)]
mod lock_type {
	pub const READ: libc::c_short = libc::F_RDLCK as libc::c_short;
	pub const WRITE: libc::c_short = libc::F_WRLCK as libc::c_short;
	pub const UNLOCKED: libc::c_short = libc::F_UNLCK as libc::c_short;
}

#[cfg(not(target_os = "linux"))]
mod lock_type {
	pub const READ: libc::c_short = libc::F_RDLCK;
	#[cfg(test)]
	pub const WRITE: libc::c_short = libc::F_WRLCK;
	pub const UNLOCKED: libc::c_short = libc::F_UNLCK;
}

/// A lock held by the sidecar's open file description; closing it releases.
pub struct PlatformLock {
	#[allow(
		dead_code,
		reason = "held for its Drop, which closes the descriptor and so releases the lock"
	)]
	file: File,
}

pub fn try_acquire(path: &CStr) -> Result<Option<PlatformLock>, Fault> {
	let Some(file) = open_sidecar(path, true)? else {
		return Err(failed("open", libc::ENOENT));
	};
	Ok(lock_exclusive(&file)?.then_some(PlatformLock { file }))
}

/// Whether a lock is held on `path`, observed without taking it.
///
/// `flock(2)` has no query, but macOS keeps `flock` and `fcntl` locks on one
/// per-vnode list, and `F_GETLK` returns the first conflicting lock there,
/// `flock` ones included (their owner reads back as pid -1; pinned by a test).
/// A whole-file read-lock query therefore sees an exclusive holder without
/// locking anything, so a concurrent acquire never meets the probe. A missing
/// sidecar means nobody has locked the path.
pub fn probe(path: &CStr) -> Result<bool, Fault> {
	let Some(file) = open_sidecar(path, false)? else {
		return Ok(false);
	};
	let query = whole_file_lock(&file, PROBE_COMMAND, lock_type::READ)
		.map_err(|errno| lock_fault(PROBE_NAME, errno))?;
	Ok(query.l_type != lock_type::UNLOCKED)
}

#[cfg(target_os = "linux")]
const PROBE_COMMAND: libc::c_int = libc::F_OFD_GETLK;
#[cfg(target_os = "linux")]
const PROBE_NAME: &str = "F_OFD_GETLK";
#[cfg(not(target_os = "linux"))]
const PROBE_COMMAND: libc::c_int = libc::F_GETLK;
#[cfg(not(target_os = "linux"))]
const PROBE_NAME: &str = "F_GETLK";

#[cfg(target_os = "linux")]
fn lock_exclusive(file: &File) -> Result<bool, Fault> {
	match whole_file_lock(file, libc::F_OFD_SETLK, lock_type::WRITE) {
		Ok(_) => Ok(true),
		Err(errno) if is_contention(errno) => Ok(false),
		Err(errno) => Err(lock_fault("F_OFD_SETLK", errno)),
	}
}

#[cfg(not(target_os = "linux"))]
fn lock_exclusive(file: &File) -> Result<bool, Fault> {
	loop {
		// SAFETY: `file` owns a live descriptor for the duration of the call.
		if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
			return Ok(true);
		}
		let errno = last_errno();
		if errno == libc::EINTR {
			continue;
		}
		if is_contention(errno) {
			return Ok(false);
		}
		return Err(lock_fault("flock", errno));
	}
}

/// Whether a non-blocking lock attempt failed only because someone holds it.
/// `F_OFD_SETLK` answers `EAGAIN` or `EACCES`; `flock(2)` `EWOULDBLOCK`.
#[cfg(target_os = "linux")]
const fn is_contention(errno: i32) -> bool {
	errno == libc::EAGAIN || errno == libc::EACCES
}

#[cfg(not(target_os = "linux"))]
const fn is_contention(errno: i32) -> bool {
	errno == libc::EWOULDBLOCK
}

/// The only lock errors that mean "no lock is possible here".
const fn is_unavailable(errno: i32) -> bool {
	errno == libc::ENOLCK || errno == libc::ENOTSUP || errno == libc::EOPNOTSUPP
}

/// Classify an error from the lock or query call itself. Errors from opening
/// or checking the sidecar never reach here: those always fail closed.
fn lock_fault(operation: &str, errno: i32) -> Fault {
	let kind = if is_unavailable(errno) {
		FileLockFailure::Unavailable
	} else {
		FileLockFailure::Failed
	};
	errno_fault(kind, operation, errno)
}

fn failed(operation: &str, errno: i32) -> Fault {
	errno_fault(FileLockFailure::Failed, operation, errno)
}

fn errno_fault(kind: FileLockFailure, operation: &str, errno: i32) -> Fault {
	let message = format!("{operation}: {}", io::Error::from_raw_os_error(errno));
	Fault::new(kind, errno_code(errno), message)
}

fn errno_code(errno: i32) -> String {
	// ENOTSUP and EOPNOTSUPP share a value on Linux, so they cannot be patterns.
	if errno == libc::ENOTSUP {
		return "ENOTSUP".to_owned();
	}
	if errno == libc::EOPNOTSUPP {
		return "EOPNOTSUPP".to_owned();
	}
	let name = match errno {
		libc::EACCES => "EACCES",
		libc::EAGAIN => "EAGAIN",
		libc::EBADF => "EBADF",
		libc::EDQUOT => "EDQUOT",
		libc::EINVAL => "EINVAL",
		libc::EIO => "EIO",
		libc::EISDIR => "EISDIR",
		libc::ELOOP => "ELOOP",
		libc::EMFILE => "EMFILE",
		libc::ENAMETOOLONG => "ENAMETOOLONG",
		libc::ENFILE => "ENFILE",
		libc::ENOENT => "ENOENT",
		libc::ENOLCK => "ENOLCK",
		libc::ENOMEM => "ENOMEM",
		libc::ENOSPC => "ENOSPC",
		libc::ENOTDIR => "ENOTDIR",
		libc::ENXIO => "ENXIO",
		libc::EPERM => "EPERM",
		libc::EROFS => "EROFS",
		libc::ESTALE => "ESTALE",
		libc::ETXTBSY => "ETXTBSY",
		_ => return format!("errno-{errno}"),
	};
	name.to_owned()
}

fn last_errno() -> i32 {
	io::Error::last_os_error()
		.raw_os_error()
		.unwrap_or(libc::EIO)
}

/// Open the sidecar without following a symlink and without blocking on a
/// special file, then require a regular, single-link file owned by this user
/// with no group or other permission bits. `Ok(None)` means a probe found no
/// sidecar. Every error here fails closed.
fn open_sidecar(path: &CStr, create: bool) -> Result<Option<File>, Fault> {
	let access = if create {
		libc::O_RDWR | libc::O_CREAT
	} else {
		libc::O_RDONLY
	};
	let flags = access | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK;
	let fd = loop {
		// SAFETY: `path` is NUL-terminated; the mode is read only with O_CREAT.
		let fd = unsafe { libc::open(path.as_ptr(), flags, SIDECAR_MODE) };
		if fd >= 0 {
			break fd;
		}
		let errno = last_errno();
		if errno == libc::EINTR {
			continue;
		}
		if errno == libc::ENOENT && !create {
			return Ok(None);
		}
		return Err(failed("open", errno));
	};
	// SAFETY: `fd` is a fresh descriptor that nothing else owns.
	let file = unsafe { File::from_raw_fd(fd) };
	let metadata = file
		.metadata()
		.map_err(|error| failed("fstat", error.raw_os_error().unwrap_or(libc::EIO)))?;
	if !metadata.is_file() {
		return Err(Fault::new(
			FileLockFailure::Failed,
			"not_regular_file",
			"lock sidecar is not a regular file",
		));
	}
	// SAFETY: geteuid has no preconditions.
	if metadata.uid() != unsafe { libc::geteuid() } {
		return Err(Fault::new(
			FileLockFailure::Failed,
			"foreign_owner",
			"lock sidecar is owned by another user",
		));
	}
	if metadata.mode() & 0o077 != 0 {
		return Err(Fault::new(
			FileLockFailure::Failed,
			"not_owner_only",
			"lock sidecar has group or other permission bits",
		));
	}
	if metadata.nlink() != 1 {
		return Err(Fault::new(
			FileLockFailure::Failed,
			"multiple_links",
			"lock sidecar has more than one link",
		));
	}
	Ok(Some(file))
}

/// Run a whole-file `fcntl` lock command, retrying `EINTR`; returns the
/// (possibly updated) lock description or the errno.
fn whole_file_lock(
	file: &File,
	command: libc::c_int,
	lock_type: libc::c_short,
) -> Result<libc::flock, i32> {
	// SAFETY: an all-zero `flock` is valid. Zero `l_whence` is `SEEK_SET`, zero
	// `l_start`/`l_len` from there covers the whole file, and zero `l_pid` is
	// what the `F_OFD_*` commands require.
	let mut lock: libc::flock = unsafe { std::mem::zeroed() };
	lock.l_type = lock_type;
	loop {
		// SAFETY: `file` owns a live descriptor and `lock` is a valid `flock`
		// for the duration of the call.
		if unsafe { libc::fcntl(file.as_raw_fd(), command, &raw mut lock) } != -1 {
			return Ok(lock);
		}
		let errno = last_errno();
		if errno != libc::EINTR {
			return Err(errno);
		}
	}
}

#[cfg(test)]
pub(crate) mod tests {
	use std::{
		ffi::CString,
		os::{
			fd::AsRawFd,
			unix::{
				ffi::OsStrExt,
				fs::{MetadataExt, PermissionsExt},
			},
		},
		path::{Path, PathBuf},
		process::{Child, Command},
		sync::{Mutex, MutexGuard, PoisonError},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::{
		Fault, FileLockFailure, PlatformLock, errno_code, lock_exclusive, lock_fault, probe,
		try_acquire,
	};

	/// Serializes the tests that spawn children with the tests that assert a
	/// lock is free right after release. A child being spawned holds a copy of
	/// every descriptor, close-on-exec ones included, until its exec closes
	/// them, so a concurrent spawn in this process can keep a released lock
	/// held for well under a millisecond. Nextest runs each test in its own
	/// process; this covers `cargo test`, which shares one.
	static SPAWN_WINDOW: Mutex<()> = Mutex::new(());

	pub(crate) fn spawn_window() -> MutexGuard<'static, ()> {
		SPAWN_WINDOW.lock().unwrap_or_else(PoisonError::into_inner)
	}

	/// A private directory removed on drop.
	struct TempDir(PathBuf);

	impl TempDir {
		fn new(label: &str) -> Self {
			let nonce = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system clock")
				.as_nanos();
			let dir = std::env::temp_dir()
				.join(format!("gjc-file-lock-{label}-{}-{nonce}", std::process::id()));
			std::fs::create_dir(&dir).expect("create temp dir");
			Self(dir)
		}

		fn path(&self, name: &str) -> CString {
			c_path(&self.0.join(name))
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	/// A child process killed and reaped on drop.
	struct ChildGuard(Child);

	impl Drop for ChildGuard {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	fn c_path(path: &Path) -> CString {
		CString::new(path.as_os_str().as_bytes()).expect("path without NUL")
	}

	fn acquire(path: &CString) -> PlatformLock {
		try_acquire(path).expect("acquire").expect("lock is free")
	}

	fn failure_code(fault: Fault) -> String {
		assert_eq!(fault.kind, FileLockFailure::Failed, "{fault:?}");
		fault.code
	}

	#[test]
	fn probe_sees_a_holder_without_taking_the_lock() {
		let _window = spawn_window();
		let dir = TempDir::new("probe");
		let path = dir.path("s.session-owner");
		assert!(!probe(&path).expect("probe a missing sidecar"));
		assert!(!dir.0.join("s.session-owner").exists(), "a probe never creates the sidecar");

		let lock = acquire(&path);
		assert!(probe(&path).expect("probe a held lock"));
		// The probe opened and closed another descriptor of the same file; the
		// lock survives that, and a second acquire in this process still loses.
		assert!(probe(&path).expect("probe again"));
		assert!(try_acquire(&path).expect("second acquire").is_none());

		drop(lock);
		assert!(!probe(&path).expect("probe a released lock"));
		let successor = acquire(&path);
		drop(successor);
		assert!(!probe(&path).expect("probe after the successor releases"));
	}

	#[test]
	fn the_lock_descriptor_is_close_on_exec() {
		let dir = TempDir::new("cloexec");
		let lock = acquire(&dir.path("s.session-owner"));
		// SAFETY: the descriptor is live while `lock` exists.
		let flags = unsafe { libc::fcntl(lock.file.as_raw_fd(), libc::F_GETFD) };
		assert_ne!(flags, -1);
		assert_ne!(flags & libc::FD_CLOEXEC, 0);
	}

	#[test]
	fn a_spawned_child_does_not_keep_the_lock() {
		let _window = spawn_window();
		let dir = TempDir::new("inherit");
		let path = dir.path("s.session-owner");
		let lock = acquire(&path);
		let _child = ChildGuard(
			Command::new("sleep")
				.arg("30")
				.spawn()
				.expect("spawn sleep"),
		);
		drop(lock);
		assert!(!probe(&path).expect("probe after release"), "the child kept the lock");

		// Control: the same lock on an inheritable descriptor outlives our
		// close while the child lives, so the assertion above can fail.
		let control_path = dir.path("control.session-owner");
		// SAFETY: the path is NUL-terminated; no O_CLOEXEC on purpose.
		let fd = unsafe { libc::open(control_path.as_ptr(), libc::O_RDWR | libc::O_CREAT, 0o600) };
		assert!(fd >= 0, "open the control sidecar");
		// SAFETY: `fd` is a fresh descriptor that nothing else owns.
		let control = unsafe { <std::fs::File as std::os::fd::FromRawFd>::from_raw_fd(fd) };
		assert!(lock_exclusive(&control).expect("lock the control"));
		let _leaky = ChildGuard(
			Command::new("sleep")
				.arg("30")
				.spawn()
				.expect("spawn sleep"),
		);
		drop(control);
		assert!(probe(&control_path).expect("probe the control"), "an inherited lock stays held");
	}

	#[test]
	fn symlinked_and_special_sidecars_fail_closed() {
		let dir = TempDir::new("refuse");
		let target = dir.0.join("target");
		std::fs::write(&target, b"").expect("write target");
		std::os::unix::fs::symlink(&target, dir.0.join("link")).expect("symlink");
		let link = dir.path("link");
		assert_eq!(failure_code(try_acquire(&link).err().expect("acquire refuses")), "ELOOP");
		assert_eq!(failure_code(probe(&link).expect_err("probe refuses")), "ELOOP");

		let fifo = dir.path("fifo");
		// SAFETY: the path is NUL-terminated.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
		assert_eq!(
			failure_code(try_acquire(&fifo).err().expect("acquire refuses")),
			"not_regular_file"
		);
		assert_eq!(failure_code(probe(&fifo).expect_err("probe refuses")), "not_regular_file");

		std::fs::create_dir(dir.0.join("dir")).expect("mkdir");
		let directory = dir.path("dir");
		assert_eq!(failure_code(try_acquire(&directory).err().expect("acquire refuses")), "EISDIR");
		assert_eq!(failure_code(probe(&directory).expect_err("probe refuses")), "not_regular_file");
	}

	#[test]
	fn loose_mode_and_extra_links_fail_closed() {
		let dir = TempDir::new("owner-only");
		let path = dir.path("s.session-owner");
		drop(acquire(&path));
		let file = dir.0.join("s.session-owner");
		assert_eq!(std::fs::metadata(&file).expect("stat").mode() & 0o777, 0o600);

		std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o640)).expect("chmod");
		assert_eq!(
			failure_code(try_acquire(&path).err().expect("acquire refuses")),
			"not_owner_only"
		);
		assert_eq!(failure_code(probe(&path).expect_err("probe refuses")), "not_owner_only");

		std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("chmod");
		std::fs::hard_link(&file, dir.0.join("alias")).expect("hard link");
		for name in ["s.session-owner", "alias"] {
			let linked = dir.path(name);
			assert_eq!(
				failure_code(try_acquire(&linked).err().expect("acquire refuses")),
				"multiple_links"
			);
			assert_eq!(failure_code(probe(&linked).expect_err("probe refuses")), "multiple_links");
		}
	}

	/// `open` refusing the sidecar is a failure, never contention. Root
	/// bypasses file permissions, so the case cannot be built as root.
	#[test]
	fn eacces_from_open_fails_closed() {
		// SAFETY: geteuid has no preconditions.
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let dir = TempDir::new("eacces");
		let path = dir.path("s.session-owner");
		drop(acquire(&path));
		let file = dir.0.join("s.session-owner");
		std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o400)).expect("chmod");
		assert_eq!(failure_code(try_acquire(&path).err().expect("acquire refuses")), "EACCES");
	}

	/// A probe that try-locked exclusively would meet a shared holder; the
	/// read-lock query does not, so it reports `free` while an exclusive
	/// acquire is still refused.
	#[test]
	fn a_shared_holder_reads_as_free_to_the_probe() {
		let dir = TempDir::new("shared");
		let path = dir.path("s.session-owner");
		drop(acquire(&path));
		let shared = std::fs::File::open(dir.0.join("s.session-owner")).expect("open");
		#[cfg(target_os = "linux")]
		super::whole_file_lock(&shared, libc::F_OFD_SETLK, super::lock_type::READ)
			.expect("shared OFD lock");
		#[cfg(target_os = "macos")]
		// SAFETY: `shared` owns a live descriptor for the duration of the call.
		assert_eq!(unsafe { libc::flock(shared.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) }, 0);
		assert!(!probe(&path).expect("probe"), "the probe met a shared holder");
		assert!(try_acquire(&path).expect("acquire").is_none(), "exclusive acquire is refused");
	}

	#[test]
	fn only_the_narrow_errno_list_is_unavailable() {
		for errno in [libc::ENOLCK, libc::ENOTSUP, libc::EOPNOTSUPP] {
			assert_eq!(lock_fault("lock", errno).kind, FileLockFailure::Unavailable, "{errno}");
		}
		for errno in [libc::EACCES, libc::EPERM, libc::EBADF, libc::EINVAL, libc::EIO] {
			assert_eq!(lock_fault("lock", errno).kind, FileLockFailure::Failed, "{errno}");
		}
		assert_eq!(errno_code(libc::ENOLCK), "ENOLCK");
		assert_eq!(errno_code(libc::EACCES), "EACCES");
		assert_eq!(errno_code(-7), "errno--7");
	}

	#[cfg(target_os = "linux")]
	#[test]
	fn eacces_from_an_ofd_lock_is_contention() {
		assert!(super::is_contention(libc::EACCES));
		assert!(super::is_contention(libc::EAGAIN));
		assert!(!super::is_contention(libc::ENOLCK));
	}

	/// The probe on macOS relies on `F_GETLK` seeing a `flock` holder. Pin it:
	/// the query reports a write lock with owner pid -1.
	#[cfg(target_os = "macos")]
	#[test]
	fn f_getlk_reports_a_flock_holder() {
		let dir = TempDir::new("getlk");
		let path = dir.path("s.session-owner");
		let _lock = acquire(&path);
		let observer = std::fs::File::open(dir.0.join("s.session-owner")).expect("open observer");
		let query =
			super::whole_file_lock(&observer, libc::F_GETLK, super::lock_type::READ).expect("F_GETLK");
		assert_eq!(query.l_type, super::lock_type::WRITE);
		assert_eq!(query.l_pid, -1);
	}
}
