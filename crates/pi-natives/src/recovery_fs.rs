//! Linux-only descriptor-relative filesystem authority for crash recovery.
//!
//! Every operation is rooted in the directory descriptor acquired by
//! [`open_recovery_fs_root`]. Relative names are walked one component at a
//! time without following symlinks, and regular files must be single-linked.

#[cfg(all(test, target_os = "linux"))]
use std::{
	cell::RefCell,
	collections::VecDeque,
	sync::{OnceLock, mpsc},
};
#[cfg(target_os = "linux")]
use std::{
	ffi::CString,
	fs::File,
	io::{Read, Seek, SeekFrom, Write},
	os::{
		fd::{AsRawFd, FromRawFd},
		unix::ffi::OsStrExt,
	},
	path::{Component, Path},
	sync::atomic::{AtomicU64, Ordering},
};

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
#[cfg(target_os = "linux")]
use parking_lot::Mutex;
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};

#[cfg(target_os = "linux")]
const MAX_CONTENT_BYTES: u64 = 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_MANAGED_CONTENT_BYTES: u64 = 128 * 1024 * 1024;
#[cfg(target_os = "linux")]
const MAX_MANAGED_TREE_DEPTH: usize = 32;
#[cfg(target_os = "linux")]
const MAX_MANAGED_TREE_FILES: u64 = 50_000;
// Entries include files and directories. Leave room for the artifact directory,
// nested directories, and managed transcript, binding, and receipt metadata
// while preserving the TypeScript artifact-file limit.
#[cfg(target_os = "linux")]
const MAX_MANAGED_TREE_ENTRIES: u64 = 60_000;
#[cfg(target_os = "linux")]
const MAX_MANAGED_TREE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "linux")]
static MANAGED_REPLACEMENT_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(all(test, target_os = "linux"))]
#[derive(Clone, Copy)]
enum RetainedPublishFault {
	Rename(i32),
	Unlink(i32),
	Sync(Option<i32>),
	PostRenameSnapshot(&'static str),
	PostExchange(&'static str),
}

#[cfg(all(test, target_os = "linux"))]
thread_local! {
	static RETAINED_PUBLISH_FAULTS: RefCell<VecDeque<RetainedPublishFault>> = const { RefCell::new(VecDeque::new()) };
}

#[cfg(all(test, target_os = "linux"))]
fn set_retained_publish_faults(faults: impl IntoIterator<Item = RetainedPublishFault>) {
	RETAINED_PUBLISH_FAULTS
		.with(|configured| *configured.borrow_mut() = faults.into_iter().collect());
}

#[cfg(all(test, target_os = "linux"))]
fn take_retained_publish_fault(rename: bool) -> Option<Option<i32>> {
	RETAINED_PUBLISH_FAULTS.with(|configured| {
		let mut configured = configured.borrow_mut();
		match configured.front().copied() {
			Some(RetainedPublishFault::Rename(code)) if rename => {
				configured.pop_front();
				Some(Some(code))
			},
			Some(RetainedPublishFault::Sync(code)) if !rename => {
				configured.pop_front();
				Some(code)
			},
			_ => None,
		}
	})
}

#[cfg(all(test, target_os = "linux"))]
fn take_post_link_unlink_fault() -> Option<i32> {
	RETAINED_PUBLISH_FAULTS.with(|configured| {
		let mut configured = configured.borrow_mut();
		match configured.front().copied() {
			Some(RetainedPublishFault::Unlink(code)) => {
				configured.pop_front();
				Some(code)
			},
			_ => None,
		}
	})
}

#[cfg(all(test, target_os = "linux"))]
fn take_post_rename_snapshot_fault() -> Option<&'static str> {
	RETAINED_PUBLISH_FAULTS.with(|configured| {
		let mut configured = configured.borrow_mut();
		match configured.front().copied() {
			Some(RetainedPublishFault::PostRenameSnapshot(code)) => {
				configured.pop_front();
				Some(code)
			},
			_ => None,
		}
	})
}

#[cfg(all(test, target_os = "linux"))]
static REPLACEMENT_BEFORE_EXCHANGE_HOOK: OnceLock<
	std::sync::Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
> = OnceLock::new();

#[cfg(all(test, target_os = "linux"))]
fn set_replacement_before_exchange_hook(hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>) {
	*REPLACEMENT_BEFORE_EXCHANGE_HOOK
		.get_or_init(|| std::sync::Mutex::new(None))
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
}

#[cfg(all(test, target_os = "linux"))]
fn pause_replacement_before_exchange_for_test() {
	if let Some((entered, resume)) = REPLACEMENT_BEFORE_EXCHANGE_HOOK
		.get_or_init(|| std::sync::Mutex::new(None))
		.lock()
		.unwrap_or_else(|poisoned| poisoned.into_inner())
		.take()
	{
		entered
			.send(())
			.expect("replacement exchange hook receiver");
		resume.recv().expect("replacement exchange hook resume");
	}
}

#[cfg(all(test, target_os = "linux"))]
fn take_post_exchange_fault() -> Option<&'static str> {
	RETAINED_PUBLISH_FAULTS.with(|configured| {
		let mut configured = configured.borrow_mut();
		match configured.front().copied() {
			Some(RetainedPublishFault::PostExchange(code)) => {
				configured.pop_front();
				Some(code)
			},
			_ => None,
		}
	})
}

#[cfg(target_os = "linux")]
fn renameat2_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
) -> std::io::Result<()> {
	#[cfg(test)]
	if let Some(Some(code)) = take_retained_publish_fault(true) {
		return Err(std::io::Error::from_raw_os_error(code));
	}
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
	if result == 0 {
		Ok(())
	} else {
		Err(std::io::Error::last_os_error())
	}
}

#[cfg(target_os = "linux")]
/// Errno values proving the filesystem does not implement `renameat2` rename
/// flags, rather than reporting a malformed request. NFS (and some FUSE and
/// overlay backends) reject every `renameat2` flag with `EINVAL`, and kernels
/// older than 3.15 answer `ENOSYS`. The no-replace syscall always passes fixed,
/// validated descriptors, names, and the single `RENAME_NOREPLACE` flag, so
/// neither errno can mean an invalid invocation here — only that the atomic
/// primitive is unavailable on this mount.
const fn rename_flags_unsupported(errno: Option<i32>) -> bool {
	matches!(errno, Some(libc::EINVAL | libc::ENOSYS))
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum NoReplacePrimitive {
	Renameat2,
	Linkat,
	MkdiratRenameat,
	Renameat2Exchange,
	LinkatExchange,
}

#[cfg(target_os = "linux")]
impl NoReplacePrimitive {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Renameat2 => "renameat2_noreplace",
			Self::Linkat => "linkat_noreplace",
			Self::MkdiratRenameat => "mkdirat_renameat_noreplace",
			Self::Renameat2Exchange => "renameat2_exchange",
			Self::LinkatExchange => "linkat_exchange",
		}
	}
}

#[cfg(target_os = "linux")]
fn lock_destination(parent: &File, name: &CString) -> std::io::Result<File> {
	// Lock the destination inode, not the read-only directory descriptor. This
	// keeps the exchange boundary usable on NFS and other mounts where an
	// exclusive flock on an O_RDONLY|O_DIRECTORY handle is not supported.
	// SAFETY: `parent` owns a valid descriptor and `name` is a validated,
	// NUL-terminated leaf. The descriptor is transferred to `File` below.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
		)
	};
	if fd < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	let lock = unsafe { File::from_raw_fd(fd) };
	// SAFETY: `lock` owns a regular destination descriptor. `flock` is advisory
	// and serializes every managed replacement that uses this helper.
	if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) } != 0 {
		return Err(std::io::Error::last_os_error());
	}
	Ok(lock)
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
enum ReplacementExchangeError {
	PreMutation {
		code:  &'static str,
		phase: &'static str,
	},
	PostMutation {
		code:      &'static str,
		phase:     &'static str,
		primitive: NoReplacePrimitive,
		identity:  Option<RecoveryFsIdentity>,
	},
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
enum FileNoReplaceError {
	PreMutation(std::io::Error),
	PostMutation(std::io::Error),
}

#[cfg(target_os = "linux")]
impl FileNoReplaceError {
	fn raw_os_error(&self) -> Option<i32> {
		match self {
			Self::PreMutation(error) | Self::PostMutation(error) => error.raw_os_error(),
		}
	}

	const fn committed(&self) -> bool {
		matches!(self, Self::PostMutation(_))
	}
}

#[cfg(target_os = "linux")]
/// Atomic no-overwrite publish of a regular file for filesystems that do not
/// implement `renameat2(RENAME_NOREPLACE)`. `linkat(2)` fails with `EEXIST`
/// when the destination name already exists, giving the identical no-overwrite
/// guarantee on every POSIX filesystem (including NFS); the fallback therefore
/// preserves — never weakens — no-replace authority. The staging source link is
/// then removed so the destination is the sole link, matching a successful
/// rename (`st_nlink == 1`).
///
/// `release_source_authority` runs after the link has published the destination
/// and before the staging name is unlinked. Callers that hold a descriptor on
/// the staged object must release it there: NFS silly-renames a still-open name
/// to `.nfsXXXX` instead of removing it, which leaves a second link to the
/// published inode and defeats the `st_nlink == 1` proof this fallback exists
/// to preserve. Releasing only after the link commits keeps descriptor
/// authority across publication itself, so the fallback is never weaker than
/// the `renameat2` primitive it stands in for.
fn linkat_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	release_source_authority: impl FnOnce(),
) -> Result<(), FileNoReplaceError> {
	// SAFETY: both parents own valid fds and both names are live NUL-terminated
	// strings for this syscall; flags are 0, so a symlink source is linked as-is.
	let linked = unsafe {
		libc::linkat(
			source_parent.as_raw_fd(),
			source_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			0,
		)
	};
	if linked != 0 {
		return Err(FileNoReplaceError::PreMutation(std::io::Error::last_os_error()));
	}
	// Publication has committed: the destination is an independent link to the
	// verified inode. Only now may the staged descriptor be released, and it must
	// be released before the unlink below (see the note above).
	release_source_authority();
	#[cfg(test)]
	if let Some(code) = take_post_link_unlink_fault() {
		return Err(FileNoReplaceError::PostMutation(std::io::Error::from_raw_os_error(code)));
	}
	// SAFETY: the source parent fd and name remain valid; the destination now
	// owns an independent hard link to the same inode.
	let unlinked = unsafe { libc::unlinkat(source_parent.as_raw_fd(), source_name.as_ptr(), 0) };
	if unlinked != 0 {
		return Err(FileNoReplaceError::PostMutation(std::io::Error::last_os_error()));
	}
	Ok(())
}

#[cfg(target_os = "linux")]
/// Atomic no-overwrite rename of a *directory* for filesystems that do not
/// implement `renameat2` rename flags. `linkat` cannot hard-link a directory,
/// so the file fallback does not apply; `mkdirat(2)` provides the missing
/// exclusivity instead. It fails with `EEXIST` when the destination name
/// already exists, which is the same no-overwrite guarantee `RENAME_NOREPLACE`
/// gives, and a successful `mkdirat` means this caller now owns that name: no
/// other publisher can create it, and nothing in this module deletes a
/// directory it has not proven. The plain `renameat(2)` that follows can
/// therefore only ever replace the empty directory just created here, and POSIX
/// refuses to rename over a *non-empty* directory, so a populated collision is
/// rejected rather than clobbered.
///
/// The destination name is briefly an empty directory instead of absent. That
/// is the only observable difference from the atomic primitive, and it fails in
/// the safe direction: a concurrent no-replace publisher racing for the same
/// name loses at `mkdirat` exactly as it would have lost to `RENAME_NOREPLACE`.
///
/// A failed rename removes the placeholder again, so a rejected publish never
/// leaves an empty directory squatting the destination name.
fn rename_directory_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
) -> std::io::Result<()> {
	// SAFETY: the destination parent owns a valid fd and the name is a live
	// NUL-terminated string for this syscall.
	if unsafe { libc::mkdirat(destination_parent.as_raw_fd(), destination_name.as_ptr(), 0o700) }
		!= 0
	{
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: both parents own valid fds and both names are live NUL-terminated
	// strings for this syscall.
	if unsafe {
		libc::renameat(
			source_parent.as_raw_fd(),
			source_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
		)
	} == 0
	{
		return Ok(());
	}
	let error = std::io::Error::last_os_error();
	// SAFETY: the destination parent fd and name remain valid; this removes only
	// the empty placeholder created above, which the failed rename did not touch.
	unsafe {
		libc::unlinkat(destination_parent.as_raw_fd(), destination_name.as_ptr(), libc::AT_REMOVEDIR)
	};
	Err(error)
}

#[cfg(target_os = "linux")]
/// No-overwrite rename of a directory. Prefers the atomic
/// `renameat2(RENAME_NOREPLACE)` primitive and falls back to the `mkdirat(2)`
/// name claim of `rename_directory_no_replace` when the filesystem does not
/// implement rename flags (see `rename_flags_unsupported`).
fn rename_tree_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
) -> std::io::Result<NoReplacePrimitive> {
	match renameat2_no_replace(source_parent, source_name, destination_parent, destination_name) {
		Ok(()) => Ok(NoReplacePrimitive::Renameat2),
		Err(error) if rename_flags_unsupported(error.raw_os_error()) => rename_directory_no_replace(
			source_parent,
			source_name,
			destination_parent,
			destination_name,
		)
		.map(|()| NoReplacePrimitive::MkdiratRenameat),
		Err(error) => Err(error),
	}
}

#[cfg(target_os = "linux")]
/// Replacement exchange for filesystems that implement no `renameat2` rename
/// flags. `RENAME_EXCHANGE` swaps two names in a single step and nothing in
/// POSIX does that — but the swap itself is not what a managed replacement
/// needs. It needs the destination to carry the candidate afterwards and the
/// displaced object to stay reachable under the candidate name as rollback
/// evidence, and `linkat(2)` reaches exactly that terminal state without the
/// destination name ever being absent:
///
/// 1. `linkat(destination -> temporary)` gives the displaced object a second
///    name before anything moves, so it survives the replacement.
/// 2. `sync_parent(candidate_parent)` makes that rollback name **durable**
///    before anything is displaced.
/// 3. `renameat(candidate -> destination)` replaces the destination in one
///    atomic step. Plain `rename` never unoccupies a name, so no reader can
///    observe a gap and no concurrent publisher can claim it.
/// 4. `renameat(temporary -> candidate)` parks the displaced object under the
///    candidate name, exactly where the exchange would have left it.
///
/// Both objects end single-linked as `RENAME_EXCHANGE` leaves them, so every
/// identity proof the caller runs afterwards is unchanged. Unlike a directory
/// exchange, which has no window-free emulation at all, this one is exact.
///
/// The pre-destructive sync establishes the enforceable fsync-fault invariant:
/// if the rollback link's parent cannot be synced, the fallback fails before
/// releasing destination authority or displacing anything. This implementation
/// does not include a literal power-loss/restart harness, so it does not claim
/// to prove filesystem-specific crash equivalence to `RENAME_EXCHANGE`; the
/// deterministic fault tests cover the failure boundary observable here.
///
/// The rollback link lives in `candidate_parent` while the replacement lands in
/// `destination_parent`, so the two directories are synced separately and in
/// that order. After the destructive rename, publication has committed and the
/// destination-parent and final candidate-parent sync failures are classified
/// as committed-but-unproven by their phase.
///
/// `release_destination_authority` runs after the rollback-link sync and before
/// the first rename. By then the displaced object is durably reachable through
/// the temporary name, and releasing before the rename avoids NFS
/// silly-renaming a still-open name.
fn exchange_through_link(
	candidate_parent: &File,
	candidate_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	release_destination_authority: impl FnOnce(),
	verify_destination: impl Fn() -> Result<(), &'static str>,
) -> Result<NoReplacePrimitive, ReplacementExchangeError> {
	let _destination_lock =
		lock_destination(destination_parent, destination_name).map_err(|_| {
			ReplacementExchangeError::PreMutation { code: "lock_failed", phase: "preflight" }
		})?;
	verify_destination()
		.map_err(|code| ReplacementExchangeError::PreMutation { code, phase: "preflight" })?;
	let temporary = CString::new(format!(
		".gjc-managed-exchange-{}-{}",
		std::process::id(),
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
	))
	.map_err(|_| ReplacementExchangeError::PreMutation { code: "io_error", phase: "preflight" })?;
	// SAFETY: both parents own valid fds and all names are live NUL-terminated
	// strings for this syscall; flags are 0, so the destination is linked as-is.
	if unsafe {
		libc::linkat(
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			candidate_parent.as_raw_fd(),
			temporary.as_ptr(),
			0,
		)
	} != 0
	{
		return Err(ReplacementExchangeError::PreMutation { code: "io_error", phase: "rename" });
	}
	// Persist the rollback name before anything is displaced. If durability is
	// unprovable, remove the link and fail before publication.
	if sync_parent(candidate_parent).is_err() {
		// SAFETY: the candidate parent fd and temporary name remain valid; this
		// removes only the link created above.
		unsafe { libc::unlinkat(candidate_parent.as_raw_fd(), temporary.as_ptr(), 0) };
		return Err(ReplacementExchangeError::PreMutation {
			code:  "durability_not_provable",
			phase: "preflight",
		});
	}
	// The displaced object is now durably reachable; release authority before the
	// rename so NFS does not silly-rename the still-open destination name.
	release_destination_authority();
	// SAFETY: both parents own valid fds and both names are live NUL-terminated
	// strings for this syscall.
	if unsafe {
		libc::renameat(
			candidate_parent.as_raw_fd(),
			candidate_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
		)
	} != 0
	{
		// Nothing was published. Drop the rollback link so the namespace is left
		// exactly as it was found.
		// SAFETY: the candidate parent fd and temporary name remain valid; this
		// removes only the rollback link created above.
		unsafe { libc::unlinkat(candidate_parent.as_raw_fd(), temporary.as_ptr(), 0) };
		return Err(ReplacementExchangeError::PreMutation { code: "io_error", phase: "rename" });
	}
	// Publication has committed. Persist the destination-parent mutation before
	// moving the rollback name; a sync failure is committed-but-unproven.
	if sync_parent(destination_parent).is_err() {
		return Err(ReplacementExchangeError::PostMutation {
			code:      "fsync_failed",
			phase:     "destination_parent_sync",
			primitive: NoReplacePrimitive::LinkatExchange,
			identity:  None,
		});
	}
	// SAFETY: the candidate parent fd and both names remain valid for this syscall.
	if unsafe {
		libc::renameat(
			candidate_parent.as_raw_fd(),
			temporary.as_ptr(),
			candidate_parent.as_raw_fd(),
			candidate_name.as_ptr(),
		)
	} != 0
	{
		// The replacement committed. The displaced object remains reachable under
		// the durable temporary name, so do not delete it.
		return Err(ReplacementExchangeError::PostMutation {
			code:      "rollback_unavailable",
			phase:     "terminal_identity",
			primitive: NoReplacePrimitive::LinkatExchange,
			identity:  None,
		});
	}
	// Settle the final rollback name's parent so the terminal namespace is durable.
	if sync_parent(candidate_parent).is_err() {
		return Err(ReplacementExchangeError::PostMutation {
			code:      "fsync_failed",
			phase:     "source_parent_sync",
			primitive: NoReplacePrimitive::LinkatExchange,
			identity:  None,
		});
	}
	Ok(NoReplacePrimitive::LinkatExchange)
}

#[cfg(target_os = "linux")]
/// Exchange a verified candidate with the destination it replaces. Prefers the
/// atomic `renameat2(RENAME_EXCHANGE)` primitive and falls back to
/// `exchange_through_link` when the filesystem does not implement rename flags
/// (see `rename_flags_unsupported`).
fn exchange_managed_replacement(
	candidate_parent: &File,
	candidate_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	release_destination_authority: impl FnOnce(),
	verify_destination: impl Fn() -> Result<(), &'static str>,
) -> Result<NoReplacePrimitive, ReplacementExchangeError> {
	let destination_lock = lock_destination(destination_parent, destination_name).map_err(|_| {
		ReplacementExchangeError::PreMutation { code: "lock_failed", phase: "preflight" }
	})?;
	#[cfg(test)]
	pause_replacement_before_exchange_for_test();
	verify_destination()
		.map_err(|code| ReplacementExchangeError::PreMutation { code, phase: "preflight" })?;
	#[cfg(test)]
	if let Some(Some(code)) = take_retained_publish_fault(true) {
		return if rename_flags_unsupported(Some(code)) {
			drop(destination_lock);
			exchange_through_link(
				candidate_parent,
				candidate_name,
				destination_parent,
				destination_name,
				release_destination_authority,
				verify_destination,
			)
		} else {
			Err(ReplacementExchangeError::PreMutation { code: "io_error", phase: "rename" })
		};
	}
	// SAFETY: retained parents and validated names make exchange atomic.
	if unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			candidate_parent.as_raw_fd(),
			candidate_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			libc::RENAME_EXCHANGE,
		)
	} == 0
	{
		return Ok(NoReplacePrimitive::Renameat2Exchange);
	}
	if !rename_flags_unsupported(std::io::Error::last_os_error().raw_os_error()) {
		return Err(ReplacementExchangeError::PreMutation { code: "io_error", phase: "rename" });
	}
	drop(destination_lock);
	exchange_through_link(
		candidate_parent,
		candidate_name,
		destination_parent,
		destination_name,
		release_destination_authority,
		verify_destination,
	)
}

#[cfg(target_os = "linux")]
/// No-overwrite publish of a regular file. Prefers the atomic
/// `renameat2(RENAME_NOREPLACE)` primitive and falls back to `linkat(2)` when
/// the filesystem does not implement rename flags (see
/// `rename_flags_unsupported`). Directory publishes must not use this helper:
/// `linkat` cannot hard-link a directory, so tree renames use
/// `rename_tree_no_replace` instead.
///
/// `release_source_authority` is only invoked on the `linkat` path, between the
/// publishing link and the staging unlink; see `linkat_no_replace`. `renameat2`
/// removes the staging name as part of the same atomic step, so there is no
/// window in which a held descriptor could block it and nothing to release.
fn rename_file_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	release_source_authority: impl FnOnce(),
) -> Result<NoReplacePrimitive, FileNoReplaceError> {
	match renameat2_no_replace(source_parent, source_name, destination_parent, destination_name) {
		Ok(()) => Ok(NoReplacePrimitive::Renameat2),
		Err(error) if rename_flags_unsupported(error.raw_os_error()) => linkat_no_replace(
			source_parent,
			source_name,
			destination_parent,
			destination_name,
			release_source_authority,
		)
		.map(|()| NoReplacePrimitive::Linkat),
		Err(error) => Err(FileNoReplaceError::PreMutation(error)),
	}
}

#[cfg(target_os = "linux")]
fn sync_parent(parent: &File) -> std::io::Result<()> {
	#[cfg(test)]
	if let Some(code) = take_retained_publish_fault(false) {
		return code
			.map_or_else(|| parent.sync_all(), |code| Err(std::io::Error::from_raw_os_error(code)));
	}
	parent.sync_all()
}

#[napi(object)]
#[derive(Debug, PartialEq, Eq)]

pub struct RecoveryFsIdentity {
	pub dev:      String,
	pub ino:      String,
	pub nlink:    String,
	pub size:     String,
	pub mtime_ns: String,
	pub ctime_ns: String,
	pub sha256:   Option<String>,
}

#[napi(object)]
pub struct RecoveryFsResult {
	pub ok:               bool,
	pub code:             Option<String>,
	pub identity:         Option<RecoveryFsIdentity>,
	pub data:             Option<Uint8Array>,
	/// Mutation classification is populated only by managed append outcomes.
	/// Read/stat/create callers leave it absent to preserve their existing
	/// result shape while append callers can distinguish a pre-write identity
	/// rejection from a committed write whose terminal receipt is unavailable.
	pub mutation_state:   Option<String>,
	pub durability_state: Option<String>,
}

/// Fail-closed outcome for a removal whose detached object remains retained.
/// `recovery_path` identifies evidence only; it grants no authority to replay
/// or delete the retained object.
#[napi(object)]
pub struct RecoveryFsRetainedCleanupResult {
	pub ok:            bool,
	pub code:          Option<String>,
	pub recovery_path: Option<String>,
	pub identity:      Option<RecoveryFsIdentity>,
	pub tree_snapshot: Option<crate::path_identity::NativeDirectoryTreeSnapshot>,
}

impl RecoveryFsRetainedCleanupResult {
	fn failure(code: &str) -> Self {
		Self {
			ok:            false,
			code:          Some(code.to_owned()),
			recovery_path: None,
			identity:      None,
			tree_snapshot: None,
		}
	}

	#[cfg(target_os = "linux")]
	fn retained_file(recovery_path: String, identity: RecoveryFsIdentity) -> Self {
		Self {
			ok:            false,
			code:          Some("cleanup_pending".to_owned()),
			recovery_path: Some(recovery_path),
			identity:      Some(identity),
			tree_snapshot: None,
		}
	}

	#[cfg(target_os = "linux")]
	fn retained_tree(
		recovery_path: String,
		tree_snapshot: crate::path_identity::NativeDirectoryTreeSnapshot,
	) -> Self {
		Self {
			ok:            false,
			code:          Some("cleanup_pending".to_owned()),
			recovery_path: Some(recovery_path),
			identity:      None,
			tree_snapshot: Some(tree_snapshot),
		}
	}
}

impl RecoveryFsResult {
	#[cfg(target_os = "linux")]
	const fn success(identity: RecoveryFsIdentity) -> Self {
		Self {
			ok:               true,
			code:             None,
			identity:         Some(identity),
			data:             None,
			mutation_state:   None,
			durability_state: None,
		}
	}

	#[cfg(target_os = "linux")]
	fn data(identity: RecoveryFsIdentity, data: Vec<u8>) -> Self {
		Self {
			ok:               true,
			code:             None,
			identity:         Some(identity),
			data:             Some(Uint8Array::from(data)),
			mutation_state:   None,
			durability_state: None,
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok:               false,
			code:             Some(code.to_owned()),
			identity:         None,
			data:             None,
			mutation_state:   None,
			durability_state: None,
		}
	}

	#[cfg(target_os = "linux")]
	fn append_success(identity: RecoveryFsIdentity) -> Self {
		Self {
			ok:               true,
			code:             None,
			identity:         Some(identity),
			data:             None,
			mutation_state:   Some("committed".to_owned()),
			durability_state: Some("proven".to_owned()),
		}
	}

	#[cfg(target_os = "linux")]
	fn append_failure(
		code: &str,
		mutation_state: &str,
		durability_state: &str,
		identity: Option<RecoveryFsIdentity>,
	) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			identity,
			data: None,
			mutation_state: Some(mutation_state.to_owned()),
			durability_state: Some(durability_state.to_owned()),
		}
	}
}

/// Bounded, path-free diagnostic evidence for one retained publication.
#[napi(object)]
#[derive(Clone)]
pub struct RecoveryFsPublishSyncFailure {
	pub phase:       String,
	pub parent_role: String,
	pub os_code:     Option<i32>,
	pub kind:        String,
}

#[cfg(target_os = "linux")]
struct RetainedPublishSuccess {
	result:    RecoveryFsResult,
	primitive: NoReplacePrimitive,
}

#[cfg(target_os = "linux")]
enum RetainedPublishError {
	Code(&'static str),
	PostMutationCode {
		code:      &'static str,
		primitive: NoReplacePrimitive,
	},
	PostMutationIo {
		code:      &'static str,
		phase:     &'static str,
		primitive: NoReplacePrimitive,
		os_code:   Option<i32>,
	},
	SyncFailures(Vec<RecoveryFsPublishSyncFailure>),
	PostMutationSyncFailures {
		failures:  Vec<RecoveryFsPublishSyncFailure>,
		primitive: NoReplacePrimitive,
	},
}

#[cfg(target_os = "linux")]
impl From<&'static str> for RetainedPublishError {
	fn from(code: &'static str) -> Self {
		Self::Code(code)
	}
}

#[cfg(target_os = "linux")]
fn retained_file_publish_error(error: FileNoReplaceError) -> RetainedPublishError {
	if error.committed() {
		return RetainedPublishError::PostMutationIo {
			code:      "io_error",
			phase:     "source_unlink",
			primitive: NoReplacePrimitive::Linkat,
			os_code:   error.raw_os_error(),
		};
	}
	match error.raw_os_error() {
		Some(libc::EEXIST) => "already_exists",
		Some(libc::ENOSYS) => "atomic_unavailable",
		// renameat2 rename flags are unavailable and linkat also failed, so
		// classify the residual errno instead of weakening no-overwrite authority.
		Some(libc::EINVAL) => "invalid_request",
		Some(libc::EXDEV) => "cross_device",
		Some(libc::EACCES | libc::EPERM) => "permission_denied",
		Some(libc::EINTR) => "interrupted",
		_ => "io_error",
	}
	.into()
}

#[cfg(target_os = "linux")]
fn bind_post_mutation_error(
	error: RetainedPublishError,
	primitive: NoReplacePrimitive,
) -> RetainedPublishError {
	match error {
		RetainedPublishError::Code(code) => {
			RetainedPublishError::PostMutationCode { code, primitive }
		},
		RetainedPublishError::SyncFailures(failures) => {
			RetainedPublishError::PostMutationSyncFailures { failures, primitive }
		},
		error => error,
	}
}

/// Bounded, path-free diagnostic evidence for one retained publication.
#[napi(object)]
pub struct RecoveryFsPublishDiagnostic {
	pub schema_version:   u32,
	pub collection_state: String,
	pub os_code:          Option<i32>,
	pub sync_failures:    Option<Vec<RecoveryFsPublishSyncFailure>>,
}

/// Explicit mutation and durability outcome for retained no-replace
/// publication.
#[napi(object)]
pub struct RecoveryFsPublishResult {
	pub ok:               bool,
	pub code:             Option<String>,
	pub identity:         Option<RecoveryFsIdentity>,
	pub mutation_state:   String,
	pub durability_state: String,
	pub reason:           String,
	pub primitive:        String,
	pub phase:            String,
	pub diagnostic:       RecoveryFsPublishDiagnostic,
}

impl RecoveryFsPublishResult {
	#[cfg(target_os = "linux")]
	fn success(identity: RecoveryFsIdentity, primitive: NoReplacePrimitive) -> Self {
		let mut result =
			Self::result(true, None, Some(identity), "committed", "proven", "none", "complete", None);
		primitive.as_str().clone_into(&mut result.primitive);
		result
	}

	fn failure(
		mutation_state: &str,
		durability_state: &str,
		reason: &str,
		phase: &str,
		code: &str,
		os_code: Option<i32>,
	) -> Self {
		Self::result(
			false,
			Some(code.to_owned()),
			None,
			mutation_state,
			durability_state,
			reason,
			phase,
			os_code,
		)
	}

	fn result(
		ok: bool,
		code: Option<String>,
		identity: Option<RecoveryFsIdentity>,
		mutation_state: &str,
		durability_state: &str,
		reason: &str,
		phase: &str,
		os_code: Option<i32>,
	) -> Self {
		Self {
			ok,
			code,
			identity,
			mutation_state: mutation_state.to_owned(),
			durability_state: durability_state.to_owned(),
			reason: reason.to_owned(),
			primitive: "renameat2_noreplace".to_owned(),
			phase: phase.to_owned(),
			diagnostic: RecoveryFsPublishDiagnostic {
				schema_version: 1,
				collection_state: if os_code.is_some() {
					"partial"
				} else {
					"complete"
				}
				.to_owned(),
				os_code,
				sync_failures: None,
			},
		}
	}
}

#[cfg(target_os = "linux")]
fn publish_preflight_failure(code: &'static str) -> RecoveryFsPublishResult {
	let (reason, phase) = match code {
		"already_exists" => ("destination_exists", "preflight"),
		"atomic_unavailable" => ("atomic_unavailable", "rename"),
		"cross_device" => ("cross_device", "rename"),
		"permission_denied" => ("permission_denied", "preflight"),
		"invalid_request" => ("invalid_request", "preflight"),
		"durability_not_provable" => ("durability_not_provable", "preflight"),
		"identity_mismatch" => ("identity_violation", "preflight"),
		_ => ("io_failure", "preflight"),
	};
	RecoveryFsPublishResult::failure("not_committed", "not_attempted", reason, phase, code, None)
}

#[cfg(target_os = "linux")]
fn publish_post_mutation_failure(code: &'static str, phase: &str) -> RecoveryFsPublishResult {
	let reason = if code == "fsync_failed" {
		"durability_not_provable"
	} else if code == "identity_mismatch" {
		"identity_violation"
	} else {
		"io_failure"
	};
	RecoveryFsPublishResult::failure("committed", "not_provable", reason, phase, code, None)
}

#[cfg(target_os = "linux")]
fn publish_post_mutation_failure_with_primitive(
	code: &'static str,
	phase: &'static str,
	primitive: NoReplacePrimitive,
	os_code: Option<i32>,
) -> RecoveryFsPublishResult {
	publish_post_mutation_failure_with_primitive_and_identity(code, phase, primitive, None, os_code)
}

#[cfg(target_os = "linux")]
fn publish_post_mutation_failure_with_primitive_and_identity(
	code: &'static str,
	phase: &'static str,
	primitive: NoReplacePrimitive,
	identity: Option<RecoveryFsIdentity>,
	os_code: Option<i32>,
) -> RecoveryFsPublishResult {
	let mut result = RecoveryFsPublishResult::result(
		false,
		Some(code.to_owned()),
		identity,
		"committed",
		"not_provable",
		if code == "fsync_failed" {
			"durability_not_provable"
		} else if code == "identity_mismatch" {
			"identity_violation"
		} else {
			"io_failure"
		},
		phase,
		os_code,
	);
	primitive.as_str().clone_into(&mut result.primitive);
	result.diagnostic.os_code = os_code;
	if os_code.is_some() {
		"partial".clone_into(&mut result.diagnostic.collection_state);
	}
	result
}

#[cfg(target_os = "linux")]
fn finish_retained_publish(success: RetainedPublishSuccess) -> RecoveryFsPublishResult {
	success.result.identity.map_or_else(
		|| {
			publish_post_mutation_failure_with_primitive(
				"identity_mismatch",
				"terminal_identity",
				success.primitive,
				None,
			)
		},
		|identity| RecoveryFsPublishResult::success(identity, success.primitive),
	)
}

#[cfg(target_os = "linux")]
fn publish_post_mutation_sync_failures(
	failures: Vec<RecoveryFsPublishSyncFailure>,
) -> RecoveryFsPublishResult {
	let phase = failures
		.first()
		.map_or("source_parent_sync", |failure| failure.phase.as_str());
	let os_code = failures.first().and_then(|failure| failure.os_code);
	let mut result = RecoveryFsPublishResult::failure(
		"committed",
		"not_provable",
		"durability_not_provable",
		phase,
		"fsync_failed",
		os_code,
	);
	"partial".clone_into(&mut result.diagnostic.collection_state);
	result.diagnostic.sync_failures = Some(failures);
	result
}

#[cfg(target_os = "linux")]
fn publish_post_mutation_sync_failures_with_primitive(
	failures: Vec<RecoveryFsPublishSyncFailure>,
	primitive: NoReplacePrimitive,
) -> RecoveryFsPublishResult {
	let mut result = publish_post_mutation_sync_failures(failures);
	primitive.as_str().clone_into(&mut result.primitive);
	result
}

#[cfg(target_os = "linux")]
fn sync_failure(
	phase: &str,
	parent_role: &str,
	error: &std::io::Error,
) -> RecoveryFsPublishSyncFailure {
	let os_code = error.raw_os_error();
	let kind = match os_code {
		Some(code) if code == libc::ENOTSUP || code == libc::EOPNOTSUPP => "unsupported",
		Some(libc::EACCES | libc::EPERM) => "permission",
		Some(libc::EIO) => "io",
		_ => "other",
	};
	RecoveryFsPublishSyncFailure {
		phase: phase.to_owned(),
		parent_role: parent_role.to_owned(),
		os_code,
		kind: kind.to_owned(),
	}
}

#[cfg(target_os = "linux")]
fn collect_parent_sync_failures(
	source_parent: &File,
	destination_parent: &File,
	shared: bool,
	mut sync: impl FnMut(&File) -> std::io::Result<()>,
) -> Result<(), RetainedPublishError> {
	let source_role = if shared { "shared" } else { "source" };
	let mut failures = Vec::with_capacity(2);
	if let Err(error) = sync(source_parent) {
		failures.push(sync_failure("source_parent_sync", source_role, &error));
	}
	if !shared && let Err(error) = sync(destination_parent) {
		failures.push(sync_failure("destination_parent_sync", "destination", &error));
	}
	if failures.is_empty() {
		Ok(())
	} else {
		Err(RetainedPublishError::SyncFailures(failures))
	}
}

#[cfg(target_os = "linux")]
fn sync_distinct_parents(
	source_parent: &File,
	destination_parent: &File,
	shared: bool,
) -> Result<(), RetainedPublishError> {
	collect_parent_sync_failures(source_parent, destination_parent, shared, sync_parent)
}

#[cfg(target_os = "linux")]
fn publish_unknown_failure(code: &'static str, phase: &str) -> RecoveryFsPublishResult {
	RecoveryFsPublishResult::failure("unknown", "not_provable", "unknown", phase, code, None)
}

/// Retained descriptor-relative regular-file authority for streamed imports.
#[napi]
pub struct RecoveryFsFile {
	#[cfg(target_os = "linux")]
	file: Mutex<Option<File>>,
}

#[napi]
impl RecoveryFsFile {
	/// Return the current identity of the retained regular file.
	#[napi]
	pub fn identity(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			self.file.lock().as_ref().map_or_else(
				|| RecoveryFsResult::failure("closed"),
				|file| {
					regular_identity(file)
						.map_or_else(RecoveryFsResult::failure, RecoveryFsResult::success)
				},
			)
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsResult::failure("unsupported_platform")
	}

	/// Read one bounded chunk from the retained file descriptor.
	#[napi]
	pub fn read_chunk(&self, offset: f64, max_bytes: u32) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			if !offset.is_finite()
				|| offset < 0.0
				|| offset.fract() != 0.0
				|| offset > 9_007_199_254_740_991.0
			{
				return RecoveryFsResult::failure("invalid_offset");
			}
			let mut guard = self.file.lock();
			let Some(file) = guard.as_mut() else {
				return RecoveryFsResult::failure("closed");
			};
			if file.seek(SeekFrom::Start(offset as u64)).is_err() {
				return RecoveryFsResult::failure("io_error");
			}
			let mut data =
				vec![0_u8; usize::try_from(max_bytes.min(1024 * 1024)).unwrap_or(1024 * 1024)];
			let Ok(bytes_read) = file.read(&mut data) else {
				return RecoveryFsResult::failure("io_error");
			};
			data.truncate(bytes_read);
			regular_identity(file).map_or_else(RecoveryFsResult::failure, |identity| {
				RecoveryFsResult::data(identity, data)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (offset, max_bytes);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Close the retained regular-file descriptor.
	#[napi]
	pub fn close(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			let mut file = self.file.lock();
			let Some(retained) = file.take() else {
				return RecoveryFsResult::failure("closed");
			};
			regular_identity(&retained)
				.map_or_else(RecoveryFsResult::failure, RecoveryFsResult::success)
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsResult::failure("unsupported_platform")
	}
}

/// Retained trusted-root authority for Linux recovery artifacts.
#[napi]
pub struct RecoveryFsRoot {
	#[cfg(target_os = "linux")]
	root:     Mutex<Option<File>>,
	#[cfg(target_os = "linux")]
	recovery: Mutex<Option<File>>,
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

	/// Derive a retained child-directory capability from this root and exact
	/// identity evidence.
	#[napi]
	pub fn retain_managed_directory(
		&self,
		relative_path: String,
		expected_dev: String,
		expected_ino: String,
	) -> napi::Result<Self> {
		#[cfg(target_os = "linux")]
		{
			let guard = self.root.lock();
			let root = guard
				.as_ref()
				.ok_or_else(|| napi::Error::from_reason("closed"))?;
			let directory = if relative_path.is_empty() {
				root
					.try_clone()
					.map_err(|_| napi::Error::from_reason("io_error"))?
			} else {
				open_existing_directory(root, &relative_path).map_err(napi::Error::from_reason)?
			};
			let retained = identity(&directory).map_err(napi::Error::from_reason)?;
			if retained.dev != expected_dev || retained.ino != expected_ino {
				return Err(napi::Error::from_reason("identity_mismatch"));
			}
			crate::path_identity::platform::verify_retained_owner_only_directory(&directory)
				.map_err(napi::Error::from_reason)?;
			let inherited_recovery = self
				.recovery
				.lock()
				.as_ref()
				.map(File::try_clone)
				.transpose()
				.map_err(|_| napi::Error::from_reason("io_error"))?;
			let recovery = match inherited_recovery {
				Some(recovery) => recovery,
				None => recovery_directory(root, None).map_err(napi::Error::from_reason)?,
			};
			Ok(Self { root: Mutex::new(Some(directory)), recovery: Mutex::new(Some(recovery)) })
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, expected_dev, expected_ino);
			Err(napi::Error::from_reason("unsupported_platform"))
		}
	}

	/// Open one regular, single-linked descendant through retained no-follow
	/// traversal.
	#[napi]
	pub fn open_file(&self, relative_path: String) -> napi::Result<RecoveryFsFile> {
		#[cfg(target_os = "linux")]
		{
			let guard = self.root.lock();
			let root = guard
				.as_ref()
				.ok_or_else(|| napi::Error::from_reason("closed"))?;
			let file = open_existing(root, &relative_path, false).map_err(napi::Error::from_reason)?;
			regular_identity(&file).map_err(napi::Error::from_reason)?;
			Ok(RecoveryFsFile { file: Mutex::new(Some(file)) })
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = relative_path;
			Err(napi::Error::from_reason("unsupported_platform"))
		}
	}

	/// Enumerate regular, single-linked descendants through retained directory
	/// descriptors. The returned data is a JSON array of relative paths.
	#[napi]
	pub fn list_files(&self, max_entries: u32) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			if max_entries == 0 || max_entries > 100_000 {
				return RecoveryFsResult::failure("invalid_limit");
			}
			with_root(&self.root, |root| {
				let initial = identity(root)?;
				let mut paths = Vec::new();
				let mut entries = 0_u32;
				list_regular_descendants(root, "", 0, max_entries, &mut entries, &mut paths)?;
				let terminal = identity(root)?;
				if initial != terminal {
					return Err("identity_mismatch");
				}
				let data = serde_json::to_vec(&paths).map_err(|_| "io_error")?;
				Ok(RecoveryFsResult::data(initial, data))
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = max_entries;
			RecoveryFsResult::failure("unsupported_platform")
		}
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
				read_with_limit(root, &relative_path, u64::from(max_bytes).min(MAX_CONTENT_BYTES))
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, max_bytes);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Read one managed artifact with the managed-storage size bound.
	#[napi]
	pub fn read_managed(&self, relative_path: String) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				read_with_limit(root, &relative_path, MAX_MANAGED_CONTENT_BYTES)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = relative_path;
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Create one previously absent regular, owner-only file and synchronously
	/// persist its contents. Existing entries are never replaced.
	#[napi]
	pub fn create(&self, relative_path: String, data: Uint8Array) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				create(root, &relative_path, data.as_ref(), MAX_CONTENT_BYTES)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, data);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Create one managed artifact with the managed-storage size bound.
	#[napi]
	pub fn create_managed(&self, relative_path: String, data: Uint8Array) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				create(root, &relative_path, data.as_ref(), MAX_MANAGED_CONTENT_BYTES)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, data);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Atomically replace one exact regular file with a newly written managed
	/// artifact. The destination must retain the supplied identity throughout
	/// authorization.
	#[napi]
	pub fn replace_managed(
		&self,
		relative_path: String,
		data: Uint8Array,
		expected_dev: String,
		expected_ino: String,
		expected_size: String,
		expected_mtime_ns: String,
		expected_ctime_ns: String,
		expected_sha256: String,
	) -> RecoveryFsPublishResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery_publish(&self.root, &self.recovery, |root, recovery| {
				replace_managed(
					root,
					recovery,
					&relative_path,
					data.as_ref(),
					&expected_dev,
					&expected_ino,
					&expected_size,
					&expected_mtime_ns,
					&expected_ctime_ns,
					&expected_sha256,
				)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (
				relative_path,
				data,
				expected_dev,
				expected_ino,
				expected_size,
				expected_mtime_ns,
				expected_ctime_ns,
				expected_sha256,
			);
			RecoveryFsPublishResult::failure(
				"not_committed",
				"not_attempted",
				"atomic_unavailable",
				"preflight",
				"unsupported_platform",
				None,
			)
		}
	}

	/// Synchronously append one record to an exact retained managed file without
	/// replacing its inode or creating recovery copies.
	#[napi]
	pub fn append_managed(
		&self,
		relative_path: String,
		data: Uint8Array,
		expected_dev: String,
		expected_ino: String,
		expected_size: String,
		expected_mtime_ns: String,
		expected_ctime_ns: String,
		expected_sha256: String,
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				append_managed(
					root,
					&relative_path,
					data.as_ref(),
					&expected_dev,
					&expected_ino,
					&expected_size,
					&expected_mtime_ns,
					&expected_ctime_ns,
					&expected_sha256,
				)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (
				relative_path,
				data,
				expected_dev,
				expected_ino,
				expected_size,
				expected_mtime_ns,
				expected_ctime_ns,
				expected_sha256,
			);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Remove one exact managed regular file through retained authority.
	#[napi]
	pub fn remove_managed(
		&self,
		relative_path: String,
		expected_dev: String,
		expected_ino: String,
		expected_size: String,
		expected_mtime_ns: String,
		expected_ctime_ns: String,
		expected_sha256: String,
	) -> RecoveryFsRetainedCleanupResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery_cleanup(&self.root, &self.recovery, |root, recovery| {
				remove_managed(
					root,
					recovery,
					&relative_path,
					&expected_dev,
					&expected_ino,
					&expected_size,
					&expected_mtime_ns,
					&expected_ctime_ns,
					&expected_sha256,
				)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (
				relative_path,
				expected_dev,
				expected_ino,
				expected_size,
				expected_mtime_ns,
				expected_ctime_ns,
				expected_sha256,
			);
			RecoveryFsRetainedCleanupResult::failure("unsupported_platform")
		}
	}

	/// Create each absent directory component beneath the retained root with
	/// owner-only security. Existing components are re-opened no-follow.
	#[napi]
	pub fn ensure_managed_directory(&self, relative_path: String) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| ensure_managed_directory(root, &relative_path))
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = relative_path;
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Move an exact managed file to an absent name entirely beneath this
	/// retained root. The source identity is rechecked after the no-replace
	/// rename, and the move is rolled back on a mismatch.
	#[napi]
	pub fn rename_managed_file_no_replace(
		&self,
		source_relative_path: String,
		destination_relative_path: String,
		expected_dev: String,
		expected_ino: String,
		expected_size: String,
		expected_mtime_ns: String,
		expected_ctime_ns: String,
		expected_sha256: String,
	) -> RecoveryFsPublishResult {
		#[cfg(target_os = "linux")]
		{
			with_root_publish(&self.root, |root| {
				rename_managed_file_no_replace(
					root,
					&source_relative_path,
					&destination_relative_path,
					&expected_dev,
					&expected_ino,
					&expected_size,
					&expected_mtime_ns,
					&expected_ctime_ns,
					&expected_sha256,
				)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (
				source_relative_path,
				destination_relative_path,
				expected_dev,
				expected_ino,
				expected_size,
				expected_mtime_ns,
				expected_ctime_ns,
				expected_sha256,
			);
			RecoveryFsPublishResult::failure(
				"not_committed",
				"not_attempted",
				"atomic_unavailable",
				"preflight",
				"unsupported_platform",
				None,
			)
		}
	}

	/// Snapshot a managed directory tree entirely through the retained root.
	#[napi]
	pub fn snapshot_managed_tree(
		&self,
		relative_path: String,
	) -> crate::path_identity::NativeDirectoryTreeResult {
		#[cfg(target_os = "linux")]
		{
			let root = self.root.lock();
			let Some(root) = root.as_ref() else {
				return crate::path_identity::NativeDirectoryTreeResult {
					ok:       false,
					code:     Some("closed".to_owned()),
					snapshot: None,
				};
			};
			snapshot_managed_tree(root, &relative_path).unwrap_or_else(|code| {
				crate::path_identity::NativeDirectoryTreeResult {
					ok:       false,
					code:     Some(code.to_owned()),
					snapshot: None,
				}
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = relative_path;
			crate::path_identity::NativeDirectoryTreeResult {
				ok:       false,
				code:     Some("unsupported_platform".to_owned()),
				snapshot: None,
			}
		}
	}

	/// Move an exact managed directory tree to an absent name through retained
	/// authority.
	#[napi]
	pub fn rename_managed_tree_no_replace(
		&self,
		source_relative_path: String,
		destination_relative_path: String,
		expected: crate::path_identity::NativeDirectoryTreeSnapshot,
	) -> RecoveryFsPublishResult {
		#[cfg(target_os = "linux")]
		{
			with_root_publish(&self.root, |root| {
				rename_managed_tree_no_replace(
					root,
					&source_relative_path,
					&destination_relative_path,
					&expected,
				)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (source_relative_path, destination_relative_path, expected);
			RecoveryFsPublishResult::failure(
				"not_committed",
				"not_attempted",
				"atomic_unavailable",
				"preflight",
				"unsupported_platform",
				None,
			)
		}
	}

	/// Remove an exact managed directory tree through retained authority.
	#[napi]
	pub fn remove_managed_tree(
		&self,
		relative_path: String,
		expected: crate::path_identity::NativeDirectoryTreeSnapshot,
	) -> RecoveryFsRetainedCleanupResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery_cleanup(&self.root, &self.recovery, |root, recovery| {
				remove_managed_tree(root, recovery, &relative_path, &expected)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, expected);
			RecoveryFsRetainedCleanupResult::failure("unsupported_platform")
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
	) -> RecoveryFsPublishResult {
		#[cfg(target_os = "linux")]
		{
			with_root_publish(&self.root, |root| {
				install(root, &source_relative_path, &destination_relative_path)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (source_relative_path, destination_relative_path);
			RecoveryFsPublishResult::failure(
				"not_committed",
				"not_attempted",
				"atomic_unavailable",
				"preflight",
				"unsupported_platform",
				None,
			)
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

	/// Fsync one expected object relative to the retained root and prove
	/// identity.
	#[napi]
	pub fn fsync_expected(
		&self,
		relative_path: String,
		directory: bool,
		expected_dev: String,
		expected_ino: String,
		expected_size: String,
		expected_mtime_ns: String,
		expected_sha256: Option<String>,
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				let file = if relative_path.is_empty() {
					root.try_clone().map_err(|_| "io_error")?
				} else if directory {
					open_existing_directory(root, &relative_path)?
				} else {
					open_existing(root, &relative_path, false)?
				};
				let before = identity(&file)?;
				if before.dev != expected_dev
					|| before.ino != expected_ino
					|| before.size != expected_size
					|| before.mtime_ns != expected_mtime_ns
				{
					return Err("identity_mismatch");
				}
				if let Some(expected) = expected_sha256.as_deref()
					&& digest_hex(&file)? != expected
				{
					return Err("identity_mismatch");
				}
				let expected_change_token = change_token(&file)?;
				file.sync_all().map_err(|_| "fsync_failed")?;
				let after = identity(&file)?;
				if after.dev != expected_dev
					|| after.ino != expected_ino
					|| after.size != expected_size
					|| after.mtime_ns != expected_mtime_ns
					|| change_token(&file)? != expected_change_token
				{
					return Err("identity_mismatch");
				}
				if let Some(expected) = expected_sha256.as_deref()
					&& digest_hex(&file)? != expected
				{
					return Err("identity_mismatch");
				}
				Ok(RecoveryFsResult::success(after))
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (
				relative_path,
				directory,
				expected_dev,
				expected_ino,
				expected_size,
				expected_mtime_ns,
				expected_sha256,
			);
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Verify owner-only directory security on the retained root descriptor.
	#[napi]
	pub fn verify_owner_only_directory(&self) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
				crate::path_identity::platform::verify_retained_owner_only_directory(root)?;
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
			self.recovery.lock().take();
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
		Ok(RecoveryFsRoot { root: Mutex::new(Some(root)), recovery: Mutex::new(None) })
	}
	#[cfg(not(target_os = "linux"))]
	{
		let _ = path;
		Err(napi::Error::from_reason("unsupported_platform"))
	}
}

#[cfg(target_os = "linux")]
fn read_with_limit(
	root: &File,
	relative_path: &str,
	max_bytes: u64,
) -> Result<RecoveryFsResult, &'static str> {
	let mut file = open_existing(root, relative_path, false)?;
	let mut before = regular_identity(&file)?;

	if before
		.size
		.parse::<u64>()
		.ok()
		.is_none_or(|size| size > max_bytes)
	{
		return Err("content_too_large");
	}
	let mut data = Vec::with_capacity(before.size.parse::<usize>().unwrap_or(0));
	let mut hasher = Sha256::new();
	let mut buffer = [0u8; 16 * 1024];
	loop {
		let count = file.read(&mut buffer).map_err(|_| "io_error")?;
		if count == 0 {
			break;
		}
		if data.len().saturating_add(count) as u64 > max_bytes {
			return Err("content_too_large");
		}
		hasher.update(&buffer[..count]);
		data.extend_from_slice(&buffer[..count]);
	}
	let after = regular_identity(&file)?;
	if after != before {
		return Err("identity_mismatch");
	}
	// Hashing the bytes while streaming proves the returned buffer came from the
	// same descriptor. Re-read the descriptor through an independent cursor so a
	// concurrent in-place mutation that restores size/mtime cannot be accepted.
	let streamed: [u8; 32] = hasher.finalize().into();
	let mut verifier = file.try_clone().map_err(|_| "io_error")?;
	verifier.seek(SeekFrom::Start(0)).map_err(|_| "io_error")?;
	let verified = crate::path_identity::digest_reader(&mut verifier).map_err(|_| "io_error")?;
	if streamed != verified || regular_identity(&file)? != before {
		return Err("identity_mismatch");
	}
	before.sha256 = Some(hex_digest(streamed));
	Ok(RecoveryFsResult::data(before, data))
}

#[cfg(target_os = "linux")]
fn digest_hex(file: &File) -> Result<String, &'static str> {
	use std::fmt::Write as _;
	let mut reader = file.try_clone().map_err(|_| "io_error")?;
	reader.seek(SeekFrom::Start(0)).map_err(|_| "io_error")?;
	let digest = crate::path_identity::digest_reader(&mut reader).map_err(|_| "io_error")?;
	let mut encoded = String::with_capacity(digest.len() * 2);
	for byte in digest {
		write!(&mut encoded, "{byte:02x}").map_err(|_| "io_error")?;
	}
	Ok(encoded)
}

#[cfg(target_os = "linux")]
fn hex_digest(digest: [u8; 32]) -> String {
	use std::fmt::Write as _;
	let mut encoded = String::with_capacity(64);
	for byte in digest {
		write!(&mut encoded, "{byte:02x}").expect("writing to String cannot fail");
	}
	encoded
}

#[cfg(target_os = "linux")]
fn change_token(file: &File) -> Result<(i64, i64), &'static str> {
	use std::os::fd::AsRawFd;
	// SAFETY: libc::stat is a plain C data structure that fstat fully initializes
	// on success.
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: file is a live descriptor and stat points to writable initialized
	// storage.
	if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } != 0 {
		return Err("io_error");
	}
	Ok((stat.st_ctime, stat.st_ctime_nsec))
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
fn with_root_publish(
	root: &Mutex<Option<File>>,
	operation: impl FnOnce(&File) -> RecoveryFsPublishResult,
) -> RecoveryFsPublishResult {
	let guard = root.lock();
	guard.as_ref().map_or_else(
		|| {
			RecoveryFsPublishResult::failure(
				"not_committed",
				"not_attempted",
				"io_failure",
				"preflight",
				"closed",
				None,
			)
		},
		operation,
	)
}

#[cfg(target_os = "linux")]
fn with_root_and_recovery_cleanup(
	root: &Mutex<Option<File>>,
	recovery: &Mutex<Option<File>>,
	operation: impl FnOnce(&File, Option<&File>) -> Result<RecoveryFsRetainedCleanupResult, &'static str>,
) -> RecoveryFsRetainedCleanupResult {
	let root_guard = root.lock();
	let Some(root) = root_guard.as_ref() else {
		return RecoveryFsRetainedCleanupResult::failure("closed");
	};
	let recovery_guard = recovery.lock();
	operation(root, recovery_guard.as_ref()).unwrap_or_else(RecoveryFsRetainedCleanupResult::failure)
}

#[cfg(target_os = "linux")]
fn with_root_and_recovery_publish(
	root: &Mutex<Option<File>>,
	recovery: &Mutex<Option<File>>,
	operation: impl FnOnce(&File, Option<&File>) -> RecoveryFsPublishResult,
) -> RecoveryFsPublishResult {
	let root_guard = root.lock();
	let Some(root) = root_guard.as_ref() else {
		return RecoveryFsPublishResult::failure(
			"not_committed",
			"not_attempted",
			"io_failure",
			"preflight",
			"closed",
			None,
		);
	};
	let recovery_guard = recovery.lock();
	operation(root, recovery_guard.as_ref())
}

#[cfg(target_os = "linux")]
fn stat_mtime_ns(stat: &libc::stat) -> i128 {
	i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtime_nsec)
}

#[cfg(target_os = "linux")]
fn stat_ctime_ns(stat: &libc::stat) -> i128 {
	i128::from(stat.st_ctime) * 1_000_000_000 + i128::from(stat.st_ctime_nsec)
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
		nlink:    stat.st_nlink.to_string(),
		size:     (stat.st_size as u64).to_string(),
		mtime_ns: stat_mtime_ns(&stat).to_string(),
		ctime_ns: stat_ctime_ns(&stat).to_string(),
		sha256:   None,
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
		nlink:    stat.st_nlink.to_string(),
		size:     (stat.st_size as u64).to_string(),
		mtime_ns: stat_mtime_ns(&stat).to_string(),
		ctime_ns: stat_ctime_ns(&stat).to_string(),
		sha256:   None,
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
fn statat(parent: &File, name: &CString) -> Result<libc::stat, &'static str> {
	use std::os::fd::AsRawFd;
	// SAFETY: libc::stat is a plain C output structure that fstatat initializes on
	// success.
	let mut named: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: parent is live, name is NUL-terminated, and named points to writable
	// storage.
	if unsafe {
		libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
	} != 0
	{
		return Err("not_found");
	}
	if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
		return Err("reparse_point");
	}
	Ok(named)
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
			libc::O_RDONLY | libc::O_NONBLOCK
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
fn open_existing_directory(root: &File, relative_path: &str) -> Result<File, &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd};
	let (parent, name) = open_parent(root, relative_path)?;
	// SAFETY: libc::stat is a plain C data structure that fstatat fully initializes
	// on success.
	let mut named: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: parent is live, name is NUL-terminated, and named points to writable
	// storage.
	if unsafe {
		libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
	} != 0
	{
		return Err("not_found");
	}
	if named.st_mode & libc::S_IFMT != libc::S_IFDIR {
		return Err("not_directory");
	}
	// SAFETY: parent is retained and name is validated; O_DIRECTORY and O_NOFOLLOW
	// constrain the result.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return Err("io_error");
	}
	// SAFETY: fd is a newly owned successful openat result.
	let file = unsafe { File::from_raw_fd(fd) };
	let actual = identity(&file)?;
	if actual.dev != named.st_dev.to_string() || actual.ino != named.st_ino.to_string() {
		return Err("identity_mismatch");
	}
	Ok(file)
}

#[cfg(target_os = "linux")]
fn list_regular_descendants(
	directory: &File,
	prefix: &str,
	depth: usize,
	max_entries: u32,
	entries: &mut u32,
	paths: &mut Vec<String>,
) -> Result<(), &'static str> {
	if depth > MAX_MANAGED_TREE_DEPTH {
		return Err("tree_too_deep");
	}
	let initial = identity(directory)?;
	let proc_path = format!("/proc/self/fd/{}", directory.as_raw_fd());
	let mut names = Vec::new();
	for entry in std::fs::read_dir(proc_path).map_err(|_| "io_error")? {
		let entry = entry.map_err(|_| "io_error")?;
		*entries = entries.checked_add(1).ok_or("entry_limit_exceeded")?;
		if *entries > max_entries {
			return Err("entry_limit_exceeded");
		}
		names.push(entry.file_name());
	}
	names.sort();
	for name in names {
		let bytes = name.as_os_str().as_bytes();
		let name_text = std::str::from_utf8(bytes).map_err(|_| "invalid_path")?;
		let component = CString::new(bytes).map_err(|_| "invalid_path")?;
		let metadata = statat(directory, &component)?;
		let relative_path = if prefix.is_empty() {
			name_text.to_owned()
		} else {
			format!("{prefix}/{name_text}")
		};
		match metadata.st_mode & libc::S_IFMT {
			libc::S_IFDIR => {
				let child = open_existing_directory(directory, name_text)?;
				list_regular_descendants(
					&child,
					&relative_path,
					depth + 1,
					max_entries,
					entries,
					paths,
				)?;
			},
			libc::S_IFREG => {
				if metadata.st_nlink != 1 {
					return Err("hard_link");
				}
				paths.push(relative_path);
			},
			libc::S_IFLNK => return Err("reparse_point"),
			_ => {},
		}
	}
	let terminal = identity(directory)?;
	if initial != terminal {
		return Err("identity_mismatch");
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn create(
	root: &File,
	relative_path: &str,
	data: &[u8],
	max_content_bytes: u64,
) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd};
	if data.len() as u64 > max_content_bytes {
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
	crate::path_identity::platform::secure_created_owner_only_file(&file)?;
	file.write_all(data).map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
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
fn same_expected(
	file: &File,
	dev: &str,
	ino: &str,
	size: &str,
	mtime_ns: &str,
	ctime_ns: &str,
	sha256: &str,
) -> Result<bool, &'static str> {
	let identity = regular_identity(file)?;
	Ok(identity.dev == dev
		&& identity.ino == ino
		&& identity.size == size
		&& identity.mtime_ns == mtime_ns
		&& identity.ctime_ns == ctime_ns
		&& digest_hex(file)? == sha256)
}

#[cfg(target_os = "linux")]
fn stat_matches_regular_identity(stat: &libc::stat, identity: &RecoveryFsIdentity) -> bool {
	(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
		&& stat.st_nlink == 1
		&& stat.st_dev.to_string() == identity.dev
		&& stat.st_ino.to_string() == identity.ino
		&& (stat.st_size as u64).to_string() == identity.size
		&& stat_mtime_ns(stat).to_string() == identity.mtime_ns
		&& stat_ctime_ns(stat).to_string() == identity.ctime_ns
}

#[cfg(target_os = "linux")]
fn same_expected_after_rename(
	file: &File,
	dev: &str,
	ino: &str,
	size: &str,
	mtime_ns: &str,
	sha256: &str,
) -> Result<bool, &'static str> {
	let identity = regular_identity(file)?;
	Ok(identity.dev == dev
		&& identity.ino == ino
		&& identity.size == size
		&& identity.mtime_ns == mtime_ns
		&& digest_hex(file)? == sha256)
}

#[cfg(target_os = "linux")]
fn ensure_managed_directory(
	root: &File,
	relative_path: &str,
) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::{AsRawFd, FromRawFd, IntoRawFd};
	let names = segments(relative_path)?;
	// SAFETY: root is a live retained directory descriptor; dup returns an
	// independently owned descriptor.
	let mut fd = unsafe { libc::dup(root.as_raw_fd()) };
	if fd < 0 {
		return Err("io_error");
	}
	for name in names {
		// SAFETY: fd is a live retained directory descriptor and name is a validated
		// NUL-terminated component.
		let created = unsafe { libc::mkdirat(fd, name.as_ptr(), 0o700) };
		if created != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
			// SAFETY: fd remains owned by this function on the mkdirat error path.
			unsafe { libc::close(fd) };
			return Err("io_error");
		}
		// SAFETY: fd is live and name is validated; O_DIRECTORY and O_NOFOLLOW
		// constrain the child.
		let next = unsafe {
			libc::openat(
				fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if next < 0 {
			// SAFETY: fd remains owned by this function when opening the child fails.
			unsafe { libc::close(fd) };
			return Err("reparse_point");
		}
		// SAFETY: next is a newly owned successful openat result.
		let directory = unsafe { File::from_raw_fd(next) };
		let secured = if created == 0 {
			crate::path_identity::platform::secure_created_owner_only_directory(&directory)
		} else {
			crate::path_identity::platform::verify_retained_owner_only_directory(&directory)
		};
		if let Err(error) = secured {
			// SAFETY: fd remains owned by this function when child security verification
			// fails.
			unsafe { libc::close(fd) };
			return Err(error);
		}
		// SAFETY: fd remains the live retained parent until its new child entry is
		// durable.
		if unsafe { libc::fsync(fd) } != 0 {
			// SAFETY: fd is still owned by this function on parent fsync failure.
			unsafe { libc::close(fd) };
			return Err("fsync_failed");
		}
		// SAFETY: the retained parent is durable and no longer needed after the child
		// was opened.
		unsafe { libc::close(fd) };
		fd = directory.into_raw_fd();
	}
	// SAFETY: fd is the final independently owned descriptor after component
	// descent.
	let directory = unsafe { File::from_raw_fd(fd) };
	directory.sync_all().map_err(|_| "fsync_failed")?;
	identity(&directory).map(RecoveryFsResult::success)
}

#[cfg(target_os = "linux")]
fn recovery_directory(root: &File, external: Option<&File>) -> Result<File, &'static str> {
	if let Some(external) = external {
		return external.try_clone().map_err(|_| "io_error");
	}
	ensure_managed_directory(root, ".gjc-recovery")?;
	open_existing_directory(root, ".gjc-recovery")
}

#[cfg(target_os = "linux")]
fn rename_managed_file_no_replace(
	root: &File,
	source: &str,
	destination: &str,
	dev: &str,
	ino: &str,
	size: &str,
	mtime_ns: &str,
	ctime_ns: &str,
	sha256: &str,
) -> RecoveryFsPublishResult {
	match rename_managed_file_no_replace_inner(
		root,
		source,
		destination,
		dev,
		ino,
		size,
		mtime_ns,
		ctime_ns,
		sha256,
	) {
		Ok(success) => finish_retained_publish(success),
		Err(RetainedPublishError::SyncFailures(failures)) => {
			publish_post_mutation_sync_failures(failures)
		},
		Err(RetainedPublishError::PostMutationSyncFailures { failures, primitive }) => {
			publish_post_mutation_sync_failures_with_primitive(failures, primitive)
		},
		Err(RetainedPublishError::Code("rollback_unavailable")) => {
			publish_post_mutation_failure("rollback_unavailable", "terminal_identity")
		},
		Err(RetainedPublishError::Code("interrupted")) => {
			publish_unknown_failure("interrupted", "rename")
		},
		Err(RetainedPublishError::Code(
			code @ ("already_exists" | "atomic_unavailable" | "cross_device" | "permission_denied"
			| "invalid_request"),
		)) => publish_preflight_failure(code),
		Err(RetainedPublishError::PostMutationCode { code, primitive }) => {
			publish_post_mutation_failure_with_primitive(code, "terminal_identity", primitive, None)
		},
		Err(RetainedPublishError::PostMutationIo { code, phase, primitive, os_code }) => {
			publish_post_mutation_failure_with_primitive(code, phase, primitive, os_code)
		},
		Err(RetainedPublishError::Code(code)) => publish_unknown_failure(code, "terminal_identity"),
	}
}

#[cfg(target_os = "linux")]
fn rename_managed_file_no_replace_inner(
	root: &File,
	source: &str,
	destination: &str,
	dev: &str,
	ino: &str,
	size: &str,
	mtime_ns: &str,
	ctime_ns: &str,
	sha256: &str,
) -> Result<RetainedPublishSuccess, RetainedPublishError> {
	let source_file = open_existing(root, source, false)?;
	crate::path_identity::platform::verify_created_owner_only_file(&source_file)?;
	if !same_expected(&source_file, dev, ino, size, mtime_ns, ctime_ns, sha256)? {
		return Err("identity_mismatch".into());
	}
	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	// The staged descriptor stays open across publication and is released only
	// between the fallback's link and its staging unlink, so NFS removes the
	// staging name instead of silly-renaming it. See `linkat_no_replace`.
	let result = rename_file_no_replace(
		&source_parent,
		&source_name,
		&destination_parent,
		&destination_name,
		move || drop(source_file),
	);
	let primitive = result.map_err(retained_file_publish_error)?;
	// The namespace mutation is authoritative immediately after renameat2 returns
	// success. Every following failure is therefore committed-but-unproven.
	let post_mutation_code = |code| RetainedPublishError::PostMutationCode { code, primitive };
	let moved_file = open_existing(root, destination, false)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?;
	crate::path_identity::platform::verify_created_owner_only_file(&moved_file)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?;
	let moved =
		regular_identity(&moved_file).map_err(|_| post_mutation_code("rollback_unavailable"))?;
	if !same_expected_after_rename(&moved_file, dev, ino, size, mtime_ns, sha256)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?
	{
		return Err(post_mutation_code("rollback_unavailable"));
	}
	let terminal = statat(&destination_parent, &destination_name)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?;
	if terminal.st_dev.to_string() != moved.dev || terminal.st_ino.to_string() != moved.ino {
		return Err(post_mutation_code("rollback_unavailable"));
	}
	let source_parent_identity =
		identity(&source_parent).map_err(|_| post_mutation_code("rollback_unavailable"))?;
	let destination_parent_identity =
		identity(&destination_parent).map_err(|_| post_mutation_code("rollback_unavailable"))?;
	sync_distinct_parents(
		&source_parent,
		&destination_parent,
		source_parent_identity.dev == destination_parent_identity.dev
			&& source_parent_identity.ino == destination_parent_identity.ino,
	)
	.map_err(|error| bind_post_mutation_error(error, primitive))?;
	let after =
		regular_identity(&moved_file).map_err(|_| post_mutation_code("rollback_unavailable"))?;
	let named_after = statat(&destination_parent, &destination_name)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?;
	crate::path_identity::platform::verify_created_owner_only_file(&moved_file)
		.map_err(|_| post_mutation_code("rollback_unavailable"))?;
	let after_digest =
		digest_hex(&moved_file).map_err(|_| post_mutation_code("rollback_unavailable"))?;
	if after.dev != moved.dev
		|| after.ino != moved.ino
		|| after.size != moved.size
		|| after.mtime_ns != moved.mtime_ns
		|| after.ctime_ns != moved.ctime_ns
		|| after_digest != sha256
		|| named_after.st_dev.to_string() != moved.dev
		|| named_after.st_ino.to_string() != moved.ino
		|| named_after.st_nlink != 1
		|| (named_after.st_size as u64).to_string() != moved.size
		|| stat_mtime_ns(&named_after).to_string() != moved.mtime_ns
		|| stat_ctime_ns(&named_after).to_string() != moved.ctime_ns
	{
		return Err(post_mutation_code("rollback_unavailable"));
	}
	Ok(RetainedPublishSuccess { result: RecoveryFsResult::success(moved), primitive })
}

#[cfg(target_os = "linux")]
fn remove_managed(
	root: &File,
	recovery: Option<&File>,
	relative_path: &str,
	expected_dev: &str,
	expected_ino: &str,
	expected_size: &str,
	expected_mtime_ns: &str,
	expected_ctime_ns: &str,
	expected_sha256: &str,
) -> Result<RecoveryFsRetainedCleanupResult, &'static str> {
	let (source_parent, name) = open_parent(root, relative_path)?;
	let authorized = open_existing(root, relative_path, false)?;
	if !same_expected(
		&authorized,
		expected_dev,
		expected_ino,
		expected_size,
		expected_mtime_ns,
		expected_ctime_ns,
		expected_sha256,
	)? {
		return Err("identity_mismatch");
	}
	let authorized_identity = regular_identity(&authorized)?;
	let quarantine = CString::new(format!(
		".gjc-managed-remove-{}-{}",
		std::process::id(),
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
	))
	.map_err(|_| "io_error")?;
	let recovery_parent = recovery_directory(root, recovery)?;
	// The parent is retained, the names are validated, and the quarantine publish
	// is atomic no-replace: renameat2(RENAME_NOREPLACE) where supported, else a
	// linkat(2) fallback for filesystems (e.g. NFS) that reject rename flags.
	//
	// `authorized` is held across the quarantine publish and released between the
	// fallback's link and its staging unlink, so the staging name is removed rather
	// than silly-renamed. Keeping it open past the unlink would leave the detached
	// object double-linked on NFS, and every subsequent proof below would fail as
	// `rollback_unavailable` even though the detach committed correctly.
	if let Err(error) =
		rename_file_no_replace(&source_parent, &name, &recovery_parent, &quarantine, move || {
			drop(authorized);
		}) {
		if error.committed() {
			return Err("rollback_unavailable");
		}
		return Err(match error.raw_os_error() {
			Some(libc::ENOSYS | libc::EINVAL) => "atomic_unavailable",
			_ => "io_error",
		});
	}
	let quarantined_relative = quarantine.to_str().map_err(|_| "io_error")?;
	// Re-acquire the detached object from its quarantined name inside the retained
	// recovery parent. The identity comparison below proves it is the very inode
	// `authorized` verified before publication, so this descriptor carries the same
	// authority the retained one did.
	let detached = open_existing(&recovery_parent, quarantined_relative, false)
		.map_err(|_| "rollback_unavailable")?;
	let detached_identity = regular_identity(&detached).map_err(|_| "rollback_unavailable")?;
	if detached_identity.dev != authorized_identity.dev
		|| detached_identity.ino != authorized_identity.ino
		|| !same_expected_after_rename(
			&detached,
			expected_dev,
			expected_ino,
			expected_size,
			expected_mtime_ns,
			expected_sha256,
		)
		.map_err(|_| "rollback_unavailable")?
	{
		return Err("rollback_unavailable");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&detached)?;
	let post_detach_identity = regular_identity(&detached)?;
	if digest_hex(&detached)? != expected_sha256 {
		return Err("rollback_unavailable");
	}
	if source_parent.sync_all().is_err() || recovery_parent.sync_all().is_err() {
		return Err("rollback_unavailable");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&detached)?;
	let terminal_identity = regular_identity(&detached)?;
	let terminal_digest = digest_hex(&detached)?;
	let terminal = statat(&recovery_parent, &quarantine).map_err(|_| "identity_mismatch")?;
	if terminal_identity != post_detach_identity
		|| terminal_identity.dev != authorized_identity.dev
		|| terminal_identity.ino != authorized_identity.ino
		|| terminal_identity.size != authorized_identity.size
		|| terminal_identity.mtime_ns != authorized_identity.mtime_ns
		|| terminal_digest != expected_sha256
		|| terminal.st_dev.to_string() != terminal_identity.dev
		|| terminal.st_ino.to_string() != terminal_identity.ino
		|| terminal.st_nlink != 1
		|| (terminal.st_size as u64).to_string() != terminal_identity.size
		|| stat_mtime_ns(&terminal).to_string() != terminal_identity.mtime_ns
		|| stat_ctime_ns(&terminal).to_string() != terminal_identity.ctime_ns
	{
		return Err("identity_mismatch");
	}
	// Canonical absence is durable, but cleanup is deliberately not replayed:
	// the verified quarantine is evidence only, not a deletion capability.
	Ok(RecoveryFsRetainedCleanupResult::retained_file(
		format!(".gjc-recovery/{quarantined_relative}"),
		terminal_identity,
	))
}

#[cfg(target_os = "linux")]
fn append_post_identity(file: &File) -> Option<RecoveryFsIdentity> {
	let mut identity = regular_identity(file).ok()?;
	identity.sha256 = digest_hex(file).ok();
	Some(identity)
}

#[cfg(target_os = "linux")]
fn append_managed(
	root: &File,
	relative_path: &str,
	data: &[u8],
	expected_dev: &str,
	expected_ino: &str,
	expected_size: &str,
	expected_mtime_ns: &str,
	expected_ctime_ns: &str,
	expected_sha256: &str,
) -> Result<RecoveryFsResult, &'static str> {
	let expected_size_value = match expected_size.parse::<u64>() {
		Ok(value) => value,
		Err(_) => {
			return Ok(RecoveryFsResult::append_failure(
				"identity_mismatch",
				"not_committed",
				"not_attempted",
				None,
			));
		},
	};
	let Some(appended_size) = expected_size_value.checked_add(data.len() as u64) else {
		return Ok(RecoveryFsResult::append_failure(
			"content_too_large",
			"not_committed",
			"not_attempted",
			None,
		));
	};
	if appended_size > MAX_MANAGED_CONTENT_BYTES {
		return Ok(RecoveryFsResult::append_failure(
			"content_too_large",
			"not_committed",
			"not_attempted",
			None,
		));
	}
	let (parent, name) = match open_parent(root, relative_path) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(code, "not_committed", "not_attempted", None));
		},
	};
	// SAFETY: the retained parent fd and validated leaf name remain live for
	// openat.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDWR | libc::O_APPEND | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		let code = match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::ENOENT) => "not_found",
			_ => "io_error",
		};
		return Ok(RecoveryFsResult::append_failure(code, "not_committed", "not_attempted", None));
	}
	// SAFETY: successful openat returned a uniquely owned fd.
	let mut file = unsafe { File::from_raw_fd(fd) };
	if crate::path_identity::platform::verify_created_owner_only_file(&file).is_err() {
		return Ok(RecoveryFsResult::append_failure(
			"permission_denied",
			"not_committed",
			"not_attempted",
			None,
		));
	}
	let matches = match same_expected(
		&file,
		expected_dev,
		expected_ino,
		expected_size,
		expected_mtime_ns,
		expected_ctime_ns,
		expected_sha256,
	) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(code, "not_committed", "not_attempted", None));
		},
	};
	if !matches {
		return Ok(RecoveryFsResult::append_failure(
			"identity_mismatch",
			"not_committed",
			"not_attempted",
			None,
		));
	}
	if file.write_all(data).is_err() {
		return Ok(RecoveryFsResult::append_failure("io_error", "unknown", "not_provable", None));
	}
	if file.sync_all().is_err() {
		return Ok(RecoveryFsResult::append_failure(
			"fsync_failed",
			"committed",
			"not_provable",
			append_post_identity(&file),
		));
	}
	if crate::path_identity::platform::verify_created_owner_only_file(&file).is_err() {
		return Ok(RecoveryFsResult::append_failure(
			"permission_denied",
			"committed",
			"not_provable",
			append_post_identity(&file),
		));
	}
	let mut identity = match regular_identity(&file) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(code, "committed", "not_provable", None));
		},
	};
	if identity.dev != expected_dev
		|| identity.ino != expected_ino
		|| identity.size != appended_size.to_string()
	{
		return Ok(RecoveryFsResult::append_failure(
			"identity_mismatch",
			"committed",
			"not_provable",
			append_post_identity(&file),
		));
	}
	let named = match statat(&parent, &name) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(
				code,
				"committed",
				"not_provable",
				append_post_identity(&file),
			));
		},
	};
	if !stat_matches_regular_identity(&named, &identity) {
		return Ok(RecoveryFsResult::append_failure(
			"identity_mismatch",
			"committed",
			"not_provable",
			append_post_identity(&file),
		));
	}
	// The digest is retained for the next append expectation. Recheck both the
	// descriptor and name after reading so a concurrent successor cannot be
	// adopted merely because it raced after the post-append identity check.
	let sha256 = match digest_hex(&file) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(
				code,
				"committed",
				"not_provable",
				append_post_identity(&file),
			));
		},
	};
	let descriptor_after = match regular_identity(&file) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(
				code,
				"committed",
				"not_provable",
				append_post_identity(&file),
			));
		},
	};
	let named_after = match statat(&parent, &name) {
		Ok(value) => value,
		Err(code) => {
			return Ok(RecoveryFsResult::append_failure(
				code,
				"committed",
				"not_provable",
				append_post_identity(&file),
			));
		},
	};
	if descriptor_after != identity || !stat_matches_regular_identity(&named_after, &identity) {
		return Ok(RecoveryFsResult::append_failure(
			"identity_mismatch",
			"committed",
			"not_provable",
			append_post_identity(&file),
		));
	}
	identity.sha256 = Some(sha256);
	if parent.sync_all().is_err() {
		return Ok(RecoveryFsResult::append_failure(
			"fsync_failed",
			"committed",
			"not_provable",
			Some(identity),
		));
	}
	Ok(RecoveryFsResult::append_success(identity))
}
#[cfg(target_os = "linux")]
const fn replace_managed_failure(code: &'static str) -> ReplacementExchangeError {
	ReplacementExchangeError::PreMutation { code, phase: "preflight" }
}

#[cfg(target_os = "linux")]
fn replacement_post_failure(
	code: &'static str,
	phase: &'static str,
	primitive: NoReplacePrimitive,
	candidate_file: &File,
	replacement_sha256: &str,
) -> ReplacementExchangeError {
	let identity = regular_identity(candidate_file).ok().map(|mut identity| {
		identity.sha256 = Some(replacement_sha256.to_owned());
		identity
	});
	ReplacementExchangeError::PostMutation { code, phase, primitive, identity }
}

#[cfg(target_os = "linux")]
fn replace_managed(
	root: &File,
	recovery: Option<&File>,
	relative_path: &str,
	data: &[u8],
	expected_dev: &str,
	expected_ino: &str,
	expected_size: &str,
	expected_mtime_ns: &str,
	expected_ctime_ns: &str,
	expected_sha256: &str,
) -> RecoveryFsPublishResult {
	match replace_managed_inner(
		root,
		recovery,
		relative_path,
		data,
		expected_dev,
		expected_ino,
		expected_size,
		expected_mtime_ns,
		expected_ctime_ns,
		expected_sha256,
	) {
		Ok((identity, primitive)) => RecoveryFsPublishResult::success(identity, primitive),
		Err(ReplacementExchangeError::PreMutation { code, phase }) => {
			let mut result = publish_preflight_failure(code);
			phase.clone_into(&mut result.phase);
			if code == "lock_failed" {
				"io_failure".clone_into(&mut result.reason);
			}
			"renameat2_exchange".clone_into(&mut result.primitive);
			result
		},
		Err(ReplacementExchangeError::PostMutation { code, phase, primitive, identity }) => {
			publish_post_mutation_failure_with_primitive_and_identity(
				code, phase, primitive, identity, None,
			)
		},
	}
}

#[cfg(target_os = "linux")]
fn replace_managed_inner(
	root: &File,
	recovery: Option<&File>,
	relative_path: &str,
	data: &[u8],
	expected_dev: &str,
	expected_ino: &str,
	expected_size: &str,
	expected_mtime_ns: &str,
	expected_ctime_ns: &str,
	expected_sha256: &str,
) -> Result<(RecoveryFsIdentity, NoReplacePrimitive), ReplacementExchangeError> {
	let recovery_parent = recovery_directory(root, recovery).map_err(replace_managed_failure)?;
	let authorized = open_existing(root, relative_path, false).map_err(replace_managed_failure)?;
	if !same_expected(
		&authorized,
		expected_dev,
		expected_ino,
		expected_size,
		expected_mtime_ns,
		expected_ctime_ns,
		expected_sha256,
	)
	.map_err(replace_managed_failure)?
	{
		return Err(replace_managed_failure("identity_mismatch"));
	}
	let candidate = (0..16)
		.find_map(|_| {
			let name = format!(
				".gjc-managed-replace-{}-{}",
				std::process::id(),
				MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
			);
			match create(&recovery_parent, &name, data, MAX_MANAGED_CONTENT_BYTES) {
				Ok(_) => Some(Ok(name)),
				Err("already_exists") => None,
				Err(error) => Some(Err(error)),
			}
		})
		.transpose()
		.map_err(replace_managed_failure)?
		.ok_or_else(|| replace_managed_failure("io_error"))?;
	let candidate_file =
		open_existing(&recovery_parent, &candidate, false).map_err(replace_managed_failure)?;
	let candidate_identity = regular_identity(&candidate_file).map_err(replace_managed_failure)?;
	let replacement_sha256 = hex_digest(Sha256::digest(data).into());
	crate::path_identity::platform::verify_created_owner_only_file(&candidate_file)
		.map_err(replace_managed_failure)?;
	if digest_hex(&candidate_file).map_err(replace_managed_failure)? != replacement_sha256 {
		return Err(replace_managed_failure("identity_mismatch"));
	}
	let candidate_parent = recovery_parent;
	let candidate_name = CString::new(candidate).map_err(|_| replace_managed_failure("io_error"))?;
	let (destination_parent, destination_name) =
		open_parent(root, relative_path).map_err(replace_managed_failure)?;
	let destination_name_text = destination_name
		.to_str()
		.map_err(|_| replace_managed_failure("io_error"))?
		.to_owned();
	let verify_destination = || -> Result<(), &'static str> {
		let current = open_existing(&destination_parent, &destination_name_text, false)
			.map_err(|_| "identity_mismatch")?;
		if same_expected(
			&current,
			expected_dev,
			expected_ino,
			expected_size,
			expected_mtime_ns,
			expected_ctime_ns,
			expected_sha256,
		)
		.map_err(|_| "io_error")?
		{
			Ok(())
		} else {
			Err("identity_mismatch")
		}
	};
	// The descriptor proving the destination's identity is held across the
	// exchange. On the link fallback it is released between the rollback link
	// and the rename that displaces the destination, while the destination lock
	// stays held so a managed successor cannot enter the mutation boundary.
	let primitive = match exchange_managed_replacement(
		&candidate_parent,
		&candidate_name,
		&destination_parent,
		&destination_name,
		move || drop(authorized),
		verify_destination,
	) {
		Ok(primitive) => primitive,
		Err(ReplacementExchangeError::PreMutation { code, phase }) => {
			return Err(ReplacementExchangeError::PreMutation { code, phase });
		},
		Err(ReplacementExchangeError::PostMutation { code, phase, primitive, .. }) => {
			return Err(replacement_post_failure(
				code,
				phase,
				primitive,
				&candidate_file,
				&replacement_sha256,
			));
		},
	};
	#[cfg(test)]
	if let Some(code) = take_post_exchange_fault() {
		return Err(replacement_post_failure(
			code,
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		));
	}
	let verified =
		(|| -> Result<(RecoveryFsIdentity, RecoveryFsIdentity, File, File), &'static str> {
			let displaced = open_existing(
				&candidate_parent,
				candidate_name.to_str().map_err(|_| "io_error")?,
				false,
			)?;
			let replacement = open_existing(root, relative_path, false)?;
			let displaced_identity = regular_identity(&displaced)?;
			let replacement_identity = regular_identity(&replacement)?;
			let named_candidate = regular_identity(&candidate_file)?;
			if named_candidate.dev != candidate_identity.dev
				|| named_candidate.ino != candidate_identity.ino
				|| digest_hex(&candidate_file)? != hex_digest(Sha256::digest(data).into())
				|| replacement_identity.dev != candidate_identity.dev
				|| replacement_identity.ino != candidate_identity.ino
				|| !same_expected_after_rename(
					&displaced,
					expected_dev,
					expected_ino,
					expected_size,
					expected_mtime_ns,
					expected_sha256,
				)? {
				return Err("identity_mismatch");
			}
			crate::path_identity::platform::verify_created_owner_only_file(&candidate_file)?;
			let named_replacement = statat(&destination_parent, &destination_name)?;
			if named_replacement.st_dev.to_string() != candidate_identity.dev
				|| named_replacement.st_ino.to_string() != candidate_identity.ino
			{
				return Err("identity_mismatch");
			}
			Ok((replacement_identity, displaced_identity, displaced, replacement))
		})();
	let Ok((replacement_identity, displaced_identity, displaced, replacement)) = verified else {
		return Err(replacement_post_failure(
			"rollback_unavailable",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		));
	};
	if primitive == NoReplacePrimitive::Renameat2Exchange {
		if sync_parent(&candidate_parent).is_err() {
			return Err(replacement_post_failure(
				"fsync_failed",
				"source_parent_sync",
				primitive,
				&candidate_file,
				&replacement_sha256,
			));
		}
		if sync_parent(&destination_parent).is_err() {
			return Err(replacement_post_failure(
				"fsync_failed",
				"destination_parent_sync",
				primitive,
				&candidate_file,
				&replacement_sha256,
			));
		}
	}
	crate::path_identity::platform::verify_created_owner_only_file(&candidate_file).map_err(
		|_| {
			replacement_post_failure(
				"rollback_unavailable",
				"terminal_identity",
				primitive,
				&candidate_file,
				&replacement_sha256,
			)
		},
	)?;
	crate::path_identity::platform::verify_created_owner_only_file(&displaced).map_err(|_| {
		replacement_post_failure(
			"rollback_unavailable",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	crate::path_identity::platform::verify_created_owner_only_file(&replacement).map_err(|_| {
		replacement_post_failure(
			"rollback_unavailable",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	let terminal_replacement_identity = regular_identity(&replacement).map_err(|_| {
		replacement_post_failure(
			"rollback_unavailable",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	let terminal_displaced_identity = regular_identity(&displaced).map_err(|_| {
		replacement_post_failure(
			"rollback_unavailable",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	let terminal_replacement = statat(&destination_parent, &destination_name).map_err(|_| {
		replacement_post_failure(
			"identity_mismatch",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	let terminal_displaced = statat(&candidate_parent, &candidate_name).map_err(|_| {
		replacement_post_failure(
			"identity_mismatch",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		)
	})?;
	if terminal_replacement_identity != replacement_identity
		|| terminal_displaced_identity != displaced_identity
		|| digest_hex(&replacement).map_err(|_| {
			replacement_post_failure(
				"rollback_unavailable",
				"terminal_identity",
				primitive,
				&candidate_file,
				&replacement_sha256,
			)
		})? != replacement_sha256
		|| digest_hex(&displaced).map_err(|_| {
			replacement_post_failure(
				"rollback_unavailable",
				"terminal_identity",
				primitive,
				&candidate_file,
				&replacement_sha256,
			)
		})? != expected_sha256
		|| !stat_matches_regular_identity(&terminal_replacement, &terminal_replacement_identity)
		|| !stat_matches_regular_identity(&terminal_displaced, &terminal_displaced_identity)
	{
		return Err(replacement_post_failure(
			"identity_mismatch",
			"terminal_identity",
			primitive,
			&candidate_file,
			&replacement_sha256,
		));
	}
	let mut replacement_identity = replacement_identity;
	replacement_identity.sha256 = Some(replacement_sha256);
	Ok((replacement_identity, primitive))
}

#[cfg(target_os = "linux")]
fn install(root: &File, source: &str, destination: &str) -> RecoveryFsPublishResult {
	match install_inner(root, source, destination) {
		Ok(success) => finish_retained_publish(success),
		Err(RetainedPublishError::SyncFailures(failures)) => {
			publish_post_mutation_sync_failures(failures)
		},
		Err(RetainedPublishError::PostMutationSyncFailures { failures, primitive }) => {
			publish_post_mutation_sync_failures_with_primitive(failures, primitive)
		},
		Err(RetainedPublishError::Code("post_mutation_identity_mismatch")) => {
			publish_post_mutation_failure("identity_mismatch", "terminal_identity")
		},
		Err(RetainedPublishError::Code("interrupted")) => {
			publish_unknown_failure("interrupted", "rename")
		},
		Err(RetainedPublishError::Code(
			code @ ("already_exists" | "atomic_unavailable" | "cross_device" | "permission_denied"
			| "invalid_request"),
		)) => publish_preflight_failure(code),
		Err(RetainedPublishError::PostMutationCode { code, primitive }) => {
			publish_post_mutation_failure_with_primitive(code, "terminal_identity", primitive, None)
		},
		Err(RetainedPublishError::PostMutationIo { code, phase, primitive, os_code }) => {
			publish_post_mutation_failure_with_primitive(code, phase, primitive, os_code)
		},
		Err(RetainedPublishError::Code(code)) => publish_unknown_failure(code, "terminal_identity"),
	}
}

#[cfg(target_os = "linux")]
fn install_inner(
	root: &File,
	source: &str,
	destination: &str,
) -> Result<RetainedPublishSuccess, RetainedPublishError> {
	let source_file = open_existing(root, source, false)?;
	let source_identity = regular_identity(&source_file)?;
	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	// Released between the fallback's link and unlink; see the matching note in
	// `rename_managed_file_no_replace_inner`.
	let result = rename_file_no_replace(
		&source_parent,
		&source_name,
		&destination_parent,
		&destination_name,
		move || drop(source_file),
	);
	let primitive = result.map_err(retained_file_publish_error)?;
	// The rename has committed; all following verification failures are durability
	// proof failures, never a new pre-mutation classification.
	let post_mutation_code = |code| RetainedPublishError::PostMutationCode { code, primitive };
	let installed = open_existing(root, destination, false)
		.map_err(|_| post_mutation_code("post_mutation_identity_mismatch"))?;
	let installed_identity = regular_identity(&installed)
		.map_err(|_| post_mutation_code("post_mutation_identity_mismatch"))?;
	if installed_identity.dev != source_identity.dev || installed_identity.ino != source_identity.ino
	{
		return Err(post_mutation_code("post_mutation_identity_mismatch"));
	}
	let source_parent_identity = identity(&source_parent)
		.map_err(|_| post_mutation_code("post_mutation_identity_mismatch"))?;
	let destination_parent_identity = identity(&destination_parent)
		.map_err(|_| post_mutation_code("post_mutation_identity_mismatch"))?;
	sync_distinct_parents(
		&source_parent,
		&destination_parent,
		source_parent_identity.dev == destination_parent_identity.dev
			&& source_parent_identity.ino == destination_parent_identity.ino,
	)
	.map_err(|error| bind_post_mutation_error(error, primitive))?;
	Ok(RetainedPublishSuccess { result: RecoveryFsResult::success(installed_identity), primitive })
}

#[cfg(target_os = "linux")]
fn tree_digest_file(file: &File) -> Result<String, &'static str> {
	use std::fmt::Write as _;
	let mut reader = file.try_clone().map_err(|_| "io_error")?;
	reader.seek(SeekFrom::Start(0)).map_err(|_| "io_error")?;
	let digest = crate::path_identity::digest_reader(&mut reader).map_err(|_| "io_error")?;
	let mut encoded = String::with_capacity(digest.len() * 2);
	for byte in digest {
		write!(&mut encoded, "{byte:02x}").map_err(|_| "io_error")?;
	}
	Ok(encoded)
}

#[cfg(target_os = "linux")]
fn tree_names(fd: libc::c_int) -> Result<Vec<Vec<u8>>, &'static str> {
	// SAFETY: fd is live and opening "." creates a fresh directory description with
	// an independent stream offset.
	let duplicate = unsafe {
		libc::openat(
			fd,
			c".".as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if duplicate < 0 {
		return Err("io_error");
	}
	// SAFETY: duplicate is live and ownership transfers to fdopendir on success.
	let directory = unsafe { libc::fdopendir(duplicate) };
	if directory.is_null() {
		// SAFETY: fdopendir failed, so duplicate remains owned and must be closed here.
		unsafe { libc::close(duplicate) };
		return Err("io_error");
	}
	let mut names = Vec::new();
	loop {
		// SAFETY: errno is thread-local and cleared immediately before readdir for
		// end/error distinction.
		unsafe { *libc::__errno_location() = 0 };
		// SAFETY: directory is a live DIR pointer owned by this function.
		let entry = unsafe { libc::readdir(directory) };
		if entry.is_null() {
			// SAFETY: errno is thread-local and read immediately after readdir returned
			// null.
			let errno = unsafe { *libc::__errno_location() };
			// SAFETY: directory is owned here and closed exactly once at iteration
			// end/error.
			unsafe { libc::closedir(directory) };
			if errno == 0 {
				names.sort();
				return Ok(names);
			}
			return Err("io_error");
		}
		// SAFETY: readdir returned a live dirent whose d_name is NUL-terminated.
		let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
		if name != b"." && name != b".." {
			names.push(name.to_vec());
		}
	}
}

#[cfg(target_os = "linux")]
fn tree_entry(
	relative_path: String,
	stat: &libc::stat,
	kind: &str,
	sha256: Option<String>,
) -> crate::path_identity::NativeDirectoryTreeEntry {
	crate::path_identity::NativeDirectoryTreeEntry {
		relative_path,
		kind: kind.to_owned(),
		dev: stat.st_dev.to_string(),
		ino: stat.st_ino.to_string(),
		nlink: stat.st_nlink.to_string(),
		size: (stat.st_size as u64).to_string(),
		mtime_ns: stat_mtime_ns(stat).to_string(),
		ctime_ns: stat_ctime_ns(stat).to_string(),
		sha256,
	}
}

#[cfg(target_os = "linux")]
struct TreeBudget {
	entries:     u64,
	files:       u64,
	total_bytes: u64,
}

#[cfg(target_os = "linux")]
fn snapshot_tree_fd(
	fd: libc::c_int,
	relative: &str,
	depth: usize,
	is_authority_root: bool,
	budget: &mut TreeBudget,
	entries: &mut Vec<crate::path_identity::NativeDirectoryTreeEntry>,
) -> Result<(), &'static str> {
	budget.entries = budget.entries.checked_add(1).ok_or("content_too_large")?;
	if budget.entries > MAX_MANAGED_TREE_ENTRIES {
		return Err("content_too_large");
	}
	if depth > MAX_MANAGED_TREE_DEPTH {
		return Err("tree_too_deep");
	}

	// SAFETY: libc::stat is a plain C output structure that fstat initializes on
	// success.
	let mut stat: libc::stat = unsafe { std::mem::zeroed() };
	// SAFETY: fd is live and stat points to writable initialized storage.
	if unsafe { libc::fstat(fd, &mut stat) } != 0 {
		return Err("io_error");
	}
	// SAFETY: fd is live and dup returns an independently owned descriptor for
	// security verification.
	let duplicate = unsafe { libc::dup(fd) };
	if duplicate < 0 {
		return Err("io_error");
	}
	// SAFETY: duplicate is a newly owned successful dup result.
	let directory = unsafe { File::from_raw_fd(duplicate) };
	crate::path_identity::platform::verify_retained_owner_only_directory(&directory)?;

	entries.push(tree_entry(relative.to_owned(), &stat, "directory", None));
	for bytes in tree_names(fd)? {
		let name = CString::new(bytes).map_err(|_| "io_error")?;
		if is_authority_root && name.as_bytes() == b".gjc-recovery" {
			// SAFETY: fd is retained and O_DIRECTORY|O_NOFOLLOW binds only the reserved
			// recovery namespace.
			let recovery_fd = unsafe {
				libc::openat(
					fd,
					name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			if recovery_fd < 0 {
				return Err("reparse_point");
			}
			// SAFETY: recovery_fd is a newly owned successful openat result.
			let recovery = unsafe { File::from_raw_fd(recovery_fd) };
			crate::path_identity::platform::verify_retained_owner_only_directory(&recovery)?;
			continue;
		}
		let name_text = name.to_str().map_err(|_| "not_utf8")?;
		let child_relative = if relative.is_empty() {
			name_text.to_owned()
		} else {
			format!("{relative}/{name_text}")
		};
		// SAFETY: libc::stat is a plain C output structure that fstatat initializes on
		// success.
		let mut child_stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: fd and name are live and child_stat points to writable initialized
		// storage.
		if unsafe { libc::fstatat(fd, name.as_ptr(), &mut child_stat, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			return Err("io_error");
		}
		match child_stat.st_mode & libc::S_IFMT {
			libc::S_IFREG => {
				if child_stat.st_nlink != 1 {
					return Err("hard_link");
				}
				if child_stat.st_size < 0 || child_stat.st_size as u64 > MAX_MANAGED_CONTENT_BYTES {
					return Err("content_too_large");
				}
				budget.files = budget.files.checked_add(1).ok_or("content_too_large")?;
				budget.total_bytes = budget
					.total_bytes
					.checked_add(child_stat.st_size as u64)
					.ok_or("content_too_large")?;
				if budget.files > MAX_MANAGED_TREE_FILES
					|| budget.total_bytes > MAX_MANAGED_TREE_TOTAL_BYTES
				{
					return Err("content_too_large");
				}
				// SAFETY: child is opened once under the retained parent without following
				// links.
				let child_fd = unsafe {
					libc::openat(
						fd,
						name.as_ptr(),
						libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
					)
				};
				if child_fd < 0 {
					return Err("reparse_point");
				}
				// SAFETY: child_fd is newly owned.
				let child = unsafe { File::from_raw_fd(child_fd) };
				crate::path_identity::platform::verify_created_owner_only_file(&child)?;
				let opened = regular_identity(&child)?;
				if opened.dev != child_stat.st_dev.to_string()
					|| opened.ino != child_stat.st_ino.to_string()
					|| opened.size != (child_stat.st_size as u64).to_string()
					|| opened.mtime_ns != stat_mtime_ns(&child_stat).to_string()
					|| opened.ctime_ns != stat_ctime_ns(&child_stat).to_string()
				{
					return Err("identity_mismatch");
				}
				let digest = tree_digest_file(&child)?;
				let after = regular_identity(&child)?;
				// SAFETY: named_after is writable output storage and fd/name remain live for
				// the terminal binding check.
				let mut named_after: libc::stat = unsafe { std::mem::zeroed() };
				// SAFETY: fd and name are live and named_after points to initialized writable
				// storage.
				let named_status = unsafe {
					libc::fstatat(fd, name.as_ptr(), &mut named_after, libc::AT_SYMLINK_NOFOLLOW)
				};
				if after != opened
					|| named_status != 0
					|| named_after.st_dev.to_string() != opened.dev
					|| named_after.st_ino.to_string() != opened.ino
					|| named_after.st_nlink != 1
					|| named_after.st_size.to_string() != opened.size
					|| stat_mtime_ns(&named_after).to_string() != opened.mtime_ns
					|| stat_ctime_ns(&named_after).to_string() != opened.ctime_ns
				{
					return Err("identity_mismatch");
				}
				entries.push(tree_entry(child_relative, &child_stat, "file", Some(digest)));
			},

			libc::S_IFDIR => {
				// SAFETY: fd is retained, name is validated, and O_DIRECTORY|O_NOFOLLOW
				// constrain the child.
				let child_fd = unsafe {
					libc::openat(
						fd,
						name.as_ptr(),
						libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					)
				};
				if child_fd < 0 {
					return Err("reparse_point");
				}
				// SAFETY: child_fd is a newly owned successful openat result.
				let child = unsafe { File::from_raw_fd(child_fd) };
				crate::path_identity::platform::verify_retained_owner_only_directory(&child)?;
				let opened = identity(&child)?;
				if opened.dev != child_stat.st_dev.to_string()
					|| opened.ino != child_stat.st_ino.to_string()
					|| opened.size != (child_stat.st_size as u64).to_string()
					|| opened.mtime_ns != stat_mtime_ns(&child_stat).to_string()
					|| opened.ctime_ns != stat_ctime_ns(&child_stat).to_string()
				{
					return Err("identity_mismatch");
				}
				snapshot_tree_fd(
					child.as_raw_fd(),
					&child_relative,
					depth + 1,
					false,
					budget,
					entries,
				)?;
				let after = identity(&child)?;
				// SAFETY: named_after is writable output storage for the terminal no-follow
				// binding check.
				let mut named_after: libc::stat = unsafe { std::mem::zeroed() };
				// SAFETY: fd and name remain live and named_after points to initialized
				// writable storage.
				let named_status = unsafe {
					libc::fstatat(fd, name.as_ptr(), &mut named_after, libc::AT_SYMLINK_NOFOLLOW)
				};
				if after != opened
					|| named_status != 0
					|| named_after.st_dev.to_string() != opened.dev
					|| named_after.st_ino.to_string() != opened.ino
					|| (named_after.st_mode & libc::S_IFMT) != libc::S_IFDIR
					|| (named_after.st_size as u64).to_string() != opened.size
					|| stat_mtime_ns(&named_after).to_string() != opened.mtime_ns
					|| stat_ctime_ns(&named_after).to_string() != opened.ctime_ns
				{
					return Err("identity_mismatch");
				}
			},
			libc::S_IFLNK => return Err("reparse_point"),
			_ => return Err("unsupported_entry"),
		}
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn snapshot_managed_tree(
	root: &File,
	relative_path: &str,
) -> Result<crate::path_identity::NativeDirectoryTreeResult, &'static str> {
	let directory = if relative_path.is_empty() {
		root.try_clone().map_err(|_| "io_error")?
	} else {
		open_existing_directory(root, relative_path)?
	};
	let before = identity(&directory)?;
	let mut entries = Vec::new();
	let mut budget = TreeBudget { entries: 0, files: 0, total_bytes: 0 };
	snapshot_tree_fd(
		directory.as_raw_fd(),
		"",
		0,
		relative_path.is_empty(),
		&mut budget,
		&mut entries,
	)?;
	let after = identity(&directory)?;
	if after != before {
		return Err("identity_mismatch");
	}
	if !relative_path.is_empty() {
		let (parent, name) = open_parent(root, relative_path)?;
		let named = statat(&parent, &name).map_err(|_| "identity_mismatch")?;
		if named.st_dev.to_string() != before.dev
			|| named.st_ino.to_string() != before.ino
			|| (named.st_size as u64).to_string() != before.size
			|| stat_mtime_ns(&named).to_string() != before.mtime_ns
			|| stat_ctime_ns(&named).to_string() != before.ctime_ns
		{
			return Err("identity_mismatch");
		}
	}
	let entry = entries.first().ok_or("io_error")?;
	Ok(crate::path_identity::NativeDirectoryTreeResult {
		ok:       true,
		code:     None,
		snapshot: Some(crate::path_identity::NativeDirectoryTreeSnapshot {
			root_dev: entry.dev.clone(),
			root_ino: entry.ino.clone(),
			entries,
		}),
	})
}

#[cfg(target_os = "linux")]
fn snapshot_managed_tree_after_rename(
	root: &File,
	relative_path: &str,
) -> Result<crate::path_identity::NativeDirectoryTreeResult, &'static str> {
	#[cfg(test)]
	if let Some(code) = take_post_rename_snapshot_fault() {
		return Err(code);
	}
	snapshot_managed_tree(root, relative_path)
}

#[cfg(target_os = "linux")]
fn tree_matches_after_rename(
	actual: &crate::path_identity::NativeDirectoryTreeSnapshot,
	expected: &crate::path_identity::NativeDirectoryTreeSnapshot,
) -> bool {
	actual.root_dev == expected.root_dev
		&& actual.root_ino == expected.root_ino
		&& actual.entries.len() == expected.entries.len()
		&& actual
			.entries
			.iter()
			.zip(&expected.entries)
			.all(|(left, right)| {
				left.relative_path == right.relative_path
					&& left.kind == right.kind
					&& left.dev == right.dev
					&& left.ino == right.ino
					&& left.nlink == right.nlink
					&& left.size == right.size
					&& left.mtime_ns == right.mtime_ns
					&& (left.relative_path.is_empty() || left.ctime_ns == right.ctime_ns)
					&& left.sha256 == right.sha256
			})
}

#[cfg(target_os = "linux")]
fn rename_managed_tree_no_replace(
	root: &File,
	source: &str,
	destination: &str,
	expected: &crate::path_identity::NativeDirectoryTreeSnapshot,
) -> RecoveryFsPublishResult {
	match rename_managed_tree_no_replace_inner(root, source, destination, expected) {
		Ok(success) => finish_retained_publish(success),
		Err(RetainedPublishError::SyncFailures(failures)) => {
			publish_post_mutation_sync_failures(failures)
		},
		Err(RetainedPublishError::PostMutationSyncFailures { failures, primitive }) => {
			publish_post_mutation_sync_failures_with_primitive(failures, primitive)
		},
		Err(RetainedPublishError::Code("rollback_unavailable")) => {
			publish_post_mutation_failure("rollback_unavailable", "terminal_identity")
		},
		Err(RetainedPublishError::Code("interrupted")) => {
			publish_unknown_failure("interrupted", "rename")
		},
		Err(RetainedPublishError::Code(
			code @ ("already_exists" | "atomic_unavailable" | "cross_device" | "permission_denied"
			| "invalid_request"),
		)) => publish_preflight_failure(code),
		Err(RetainedPublishError::PostMutationCode { code, primitive }) => {
			publish_post_mutation_failure_with_primitive(code, "terminal_identity", primitive, None)
		},
		Err(RetainedPublishError::PostMutationIo { code, phase, primitive, os_code }) => {
			publish_post_mutation_failure_with_primitive(code, phase, primitive, os_code)
		},
		Err(RetainedPublishError::Code(code)) => publish_unknown_failure(code, "terminal_identity"),
	}
}

#[cfg(target_os = "linux")]
fn rename_managed_tree_no_replace_inner(
	root: &File,
	source: &str,
	destination: &str,
	expected: &crate::path_identity::NativeDirectoryTreeSnapshot,
) -> Result<RetainedPublishSuccess, RetainedPublishError> {
	let before = snapshot_managed_tree(root, source)?
		.snapshot
		.ok_or("io_error")?;
	if &before != expected {
		return Err("identity_mismatch".into());
	}
	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	let primitive = match rename_tree_no_replace(
		&source_parent,
		&source_name,
		&destination_parent,
		&destination_name,
	) {
		Ok(primitive) => primitive,
		Err(error) => {
			return Err(
				match error.raw_os_error() {
					Some(libc::EEXIST) => "already_exists",
					Some(libc::ENOSYS) => "atomic_unavailable",
					Some(libc::EINVAL) => "invalid_request",
					Some(libc::EXDEV) => "cross_device",
					Some(libc::EACCES | libc::EPERM) => "permission_denied",
					Some(libc::EINTR) => "interrupted",
					_ => "io_error",
				}
				.into(),
			);
		},
	};
	let post_mutation = (|| -> Result<RecoveryFsIdentity, RetainedPublishError> {
		let after = snapshot_managed_tree_after_rename(root, destination)?
			.snapshot
			.ok_or("io_error")?;
		if !tree_matches_after_rename(&after, expected) {
			return Err("identity_mismatch".into());
		}
		let source_parent_identity = identity(&source_parent)?;
		let destination_parent_identity = identity(&destination_parent)?;
		sync_distinct_parents(
			&source_parent,
			&destination_parent,
			source_parent_identity.dev == destination_parent_identity.dev
				&& source_parent_identity.ino == destination_parent_identity.ino,
		)?;
		let terminal = snapshot_managed_tree_after_rename(root, destination)?
			.snapshot
			.ok_or("io_error")?;
		if terminal != after {
			return Err("identity_mismatch".into());
		}
		let destination_root = open_existing_directory(root, destination)?;
		let destination_identity = identity(&destination_root)?;
		if destination_identity.dev != expected.root_dev
			|| destination_identity.ino != expected.root_ino
		{
			return Err("identity_mismatch".into());
		}
		Ok(destination_identity)
	})();
	match post_mutation {
		Ok(identity) => {
			Ok(RetainedPublishSuccess { result: RecoveryFsResult::success(identity), primitive })
		},
		Err(error) => Err(bind_post_mutation_error(error, primitive)),
	}
}

#[cfg(target_os = "linux")]
fn remove_managed_tree(
	root: &File,
	recovery: Option<&File>,
	relative_path: &str,
	expected: &crate::path_identity::NativeDirectoryTreeSnapshot,
) -> Result<RecoveryFsRetainedCleanupResult, &'static str> {
	let snapshot = snapshot_managed_tree(root, relative_path)?
		.snapshot
		.ok_or("io_error")?;
	if &snapshot != expected {
		return Err("identity_mismatch");
	}
	identity(root)?;
	let (source_parent, name) = open_parent(root, relative_path)?;
	let quarantine = CString::new(format!(
		".gjc-managed-tree-remove-{}-{}",
		std::process::id(),
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
	))
	.map_err(|_| "io_error")?;
	let recovery_parent = recovery_directory(root, recovery)?;
	// Retained parents and validated names make the detach no-replace. The
	// quarantine name is freshly minted and therefore absent, so on a filesystem
	// without rename flags the `mkdirat` claim inside `rename_tree_no_replace`
	// carries the same exclusivity the atomic primitive would have.
	if rename_tree_no_replace(&source_parent, &name, &recovery_parent, &quarantine).is_err() {
		return Err("io_error");
	}
	let detached = quarantine.to_str().map_err(|_| "io_error")?;
	let verified = snapshot_managed_tree(&recovery_parent, detached)
		.and_then(|result| result.snapshot.ok_or("io_error"));
	let verified_snapshot = match verified {
		Ok(value) if tree_matches_after_rename(&value, expected) => value,
		_ => return Err("rollback_unavailable"),
	};
	if source_parent.sync_all().is_err() || recovery_parent.sync_all().is_err() {
		return Err("rollback_unavailable");
	}
	let terminal = snapshot_managed_tree(&recovery_parent, detached)?
		.snapshot
		.ok_or("io_error")?;
	if terminal != verified_snapshot {
		return Err("identity_mismatch");
	}
	// Canonical absence is durable, but cleanup is deliberately not replayed:
	// the verified quarantine is evidence only, not a deletion capability.
	Ok(RecoveryFsRetainedCleanupResult::retained_tree(format!(".gjc-recovery/{detached}"), terminal))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
	use super::*;

	fn failures(result: Result<(), RetainedPublishError>) -> Vec<RecoveryFsPublishSyncFailure> {
		match result {
			Err(RetainedPublishError::SyncFailures(failures)) => failures,
			_ => panic!("expected retained parent sync failure evidence"),
		}
	}

	#[test]
	fn retained_parent_sync_evidence_records_source_destination_and_error_kinds() {
		let parent = File::open("/").expect("root directory must be openable");
		let mut calls = 0;
		let source_only = failures(collect_parent_sync_failures(&parent, &parent, false, |_| {
			calls += 1;
			if calls == 1 {
				Err(std::io::Error::from_raw_os_error(libc::EIO))
			} else {
				Ok(())
			}
		}));
		assert_eq!(source_only.len(), 1);
		assert_eq!(source_only[0].parent_role, "source");
		assert_eq!(source_only[0].phase, "source_parent_sync");
		assert_eq!(source_only[0].kind, "io");
		assert_eq!(source_only[0].os_code, Some(libc::EIO));

		let mut calls = 0;
		let destination_only =
			failures(collect_parent_sync_failures(&parent, &parent, false, |_| {
				calls += 1;
				if calls == 1 {
					Ok(())
				} else {
					Err(std::io::Error::from_raw_os_error(libc::EACCES))
				}
			}));
		assert_eq!(destination_only.len(), 1);
		assert_eq!(destination_only[0].parent_role, "destination");
		assert_eq!(destination_only[0].phase, "destination_parent_sync");
		assert_eq!(destination_only[0].kind, "permission");

		let mut calls = 0;
		let both = failures(collect_parent_sync_failures(&parent, &parent, false, |_| {
			calls += 1;
			Err(std::io::Error::from_raw_os_error(if calls == 1 { libc::EIO } else { libc::ENOTSUP }))
		}));
		assert_eq!(both.len(), 2);
		assert_eq!(both[1].kind, "unsupported");
	}

	#[test]
	fn shared_parent_sync_is_attempted_once_and_reports_a_shared_role() {
		let parent = File::open("/").expect("root directory must be openable");
		let mut calls = 0;
		let shared = failures(collect_parent_sync_failures(&parent, &parent, true, |_| {
			calls += 1;
			Err(std::io::Error::from_raw_os_error(libc::EIO))
		}));
		assert_eq!(calls, 1);
		assert_eq!(shared.len(), 1);
		assert_eq!(shared[0].parent_role, "shared");
		assert_eq!(shared[0].phase, "source_parent_sync");
	}

	use std::{
		cell::Cell,
		fs,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"pi-recovery-fs-fault-test-{}-{}",
				std::process::id(),
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("clock before epoch")
					.as_nanos(),
			));
			fs::create_dir(&path).expect("create temporary root");
			Self(path)
		}

		fn root(&self) -> File {
			File::open(&self.0).expect("open temporary root")
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn managed_file(root: &File, path: &str, contents: &[u8]) -> RecoveryFsIdentity {
		create(root, path, contents, MAX_MANAGED_CONTENT_BYTES)
			.expect("create managed source")
			.identity
			.expect("managed source identity")
	}

	fn file_digest(contents: &[u8]) -> String {
		hex_digest(Sha256::digest(contents).into())
	}

	#[test]
	fn managed_append_identity_mismatch_before_write_is_not_committed() {
		let temporary = TempDir::new();
		let root = temporary.root();
		let original = b"original-transcript";
		let identity = managed_file(&root, "transcript", original);
		let result = append_managed(
			&root,
			"transcript",
			b"append",
			&identity.dev,
			"wrong-inode",
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(original),
		)
		.expect("append result");

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.mutation_state.as_deref(), Some("not_committed"));
		assert_eq!(result.durability_state.as_deref(), Some("not_attempted"));
		assert_eq!(fs::read(temporary.0.join("transcript")).expect("transcript"), original);
	}

	fn assert_unsynced(result: &RecoveryFsPublishResult, role: &str, failures: usize) {
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("fsync_failed"));
		assert_eq!(result.mutation_state, "committed");
		assert_eq!(result.durability_state, "not_provable");
		assert_eq!(result.reason, "durability_not_provable");
		let evidence = result
			.diagnostic
			.sync_failures
			.as_ref()
			.expect("sync evidence");
		assert_eq!(evidence.len(), failures);
		assert_eq!(evidence[0].parent_role, role);
	}

	#[test]
	fn retained_publication_faults_preserve_committed_file_tree_and_install_contents() {
		let source_contents = b"source-only";
		for (faults, role, failures) in [
			(
				vec![RetainedPublishFault::Sync(Some(libc::EIO)), RetainedPublishFault::Sync(None)],
				"source",
				1,
			),
			(
				vec![RetainedPublishFault::Sync(None), RetainedPublishFault::Sync(Some(libc::EACCES))],
				"destination",
				1,
			),
			(
				vec![
					RetainedPublishFault::Sync(Some(libc::EIO)),
					RetainedPublishFault::Sync(Some(libc::EACCES)),
				],
				"source",
				2,
			),
		] {
			let temporary = TempDir::new();
			let root = temporary.root();
			ensure_managed_directory(&root, "source-parent").expect("create source parent");
			ensure_managed_directory(&root, "destination-parent").expect("create destination parent");
			let identity = managed_file(&root, "source-parent/source", source_contents);
			set_retained_publish_faults(faults);
			let result = rename_managed_file_no_replace(
				&root,
				"source-parent/source",
				"destination-parent/destination",
				&identity.dev,
				&identity.ino,
				&identity.size,
				&identity.mtime_ns,
				&identity.ctime_ns,
				&file_digest(source_contents),
			);
			assert_unsynced(&result, role, failures);
			assert!(!temporary.0.join("source-parent/source").exists());
			assert_eq!(
				fs::read(temporary.0.join("destination-parent/destination"))
					.expect("read committed destination"),
				source_contents
			);
		}

		let temporary = TempDir::new();
		let root = temporary.root();
		let source = b"install";
		managed_file(&root, "source", source);
		set_retained_publish_faults([RetainedPublishFault::Sync(Some(libc::EIO))]);
		let result = install(&root, "source", "destination");
		assert_unsynced(&result, "shared", 1);
		assert!(!temporary.0.join("source").exists());
		assert_eq!(
			fs::read(temporary.0.join("destination")).expect("read committed install"),
			source
		);

		let temporary = TempDir::new();
		let root = temporary.root();
		ensure_managed_directory(&root, "source").expect("create source tree");
		managed_file(&root, "source/receipt", b"tree");
		let expected = snapshot_managed_tree(&root, "source")
			.expect("snapshot source tree")
			.snapshot
			.expect("source tree snapshot");
		set_retained_publish_faults([RetainedPublishFault::Sync(Some(libc::EIO))]);
		let result = rename_managed_tree_no_replace(&root, "source", "destination", &expected);
		assert_unsynced(&result, "shared", 1);
		assert!(!temporary.0.join("source").exists());
		assert_eq!(
			fs::read(temporary.0.join("destination/receipt")).expect("read committed tree"),
			b"tree"
		);
	}

	#[test]
	fn retained_tree_post_rename_snapshot_failures_remain_committed_not_provable() {
		for (fault, reason) in [
			(RetainedPublishFault::PostRenameSnapshot("io_error"), "io_failure"),
			(RetainedPublishFault::PostRenameSnapshot("identity_mismatch"), "identity_violation"),
		] {
			let temporary = TempDir::new();
			let root = temporary.root();
			ensure_managed_directory(&root, "source").expect("create source tree");
			managed_file(&root, "source/receipt", b"tree");
			let expected = snapshot_managed_tree(&root, "source")
				.expect("snapshot source tree")
				.snapshot
				.expect("source tree snapshot");
			set_retained_publish_faults([fault]);
			let result = rename_managed_tree_no_replace(&root, "source", "destination", &expected);
			assert!(!result.ok);
			assert_eq!(
				result.code.as_deref(),
				Some(match fault {
					RetainedPublishFault::PostRenameSnapshot(code) => code,
					_ => unreachable!("post-rename snapshot fault"),
				})
			);
			assert_eq!(result.mutation_state, "committed");
			assert_eq!(result.durability_state, "not_provable");
			assert_eq!(result.reason, reason);
			assert!(!temporary.0.join("source").exists());
			assert_eq!(
				fs::read(temporary.0.join("destination/receipt")).expect("read committed tree"),
				b"tree"
			);
		}
	}

	#[test]
	fn retained_publication_rename_faults_are_unknown_or_preflight_without_loss() {
		for (fault, mutation_state, durability_state, reason, code) in [
			(libc::EINTR, "unknown", "not_provable", "unknown", "interrupted"),
			(libc::EXDEV, "not_committed", "not_attempted", "cross_device", "cross_device"),
			(libc::EACCES, "not_committed", "not_attempted", "permission_denied", "permission_denied"),
		] {
			let temporary = TempDir::new();
			let root = temporary.root();
			managed_file(&root, "source", b"authoritative-source");
			set_retained_publish_faults([RetainedPublishFault::Rename(fault)]);
			let result = install(&root, "source", "destination");
			assert!(!result.ok);
			assert_eq!(result.code.as_deref(), Some(code));
			assert_eq!(result.mutation_state, mutation_state);
			assert_eq!(result.durability_state, durability_state);
			assert_eq!(result.reason, reason);
			assert_eq!(
				fs::read(temporary.0.join("source")).expect("source remains authoritative"),
				b"authoritative-source"
			);
			assert!(!temporary.0.join("destination").exists());
		}
	}

	#[test]
	fn retained_publish_faults_are_thread_local_under_concurrent_installs() {
		let first = std::thread::spawn(|| {
			let temporary = TempDir::new();
			let root = temporary.root();
			managed_file(&root, "source", b"first");
			set_retained_publish_faults([RetainedPublishFault::Sync(Some(libc::EIO))]);
			let result = install(&root, "source", "destination");
			(
				result
					.diagnostic
					.sync_failures
					.expect("first sync evidence")[0]
					.os_code,
				fs::read(temporary.0.join("destination")).expect("first committed destination"),
			)
		});
		let second = std::thread::spawn(|| {
			let temporary = TempDir::new();
			let root = temporary.root();
			managed_file(&root, "source", b"second");
			set_retained_publish_faults([RetainedPublishFault::Sync(Some(libc::EACCES))]);
			let result = install(&root, "source", "destination");
			(
				result
					.diagnostic
					.sync_failures
					.expect("second sync evidence")[0]
					.os_code,
				fs::read(temporary.0.join("destination")).expect("second committed destination"),
			)
		});
		assert_eq!(first.join().expect("first install thread"), (Some(libc::EIO), b"first".to_vec()));
		assert_eq!(
			second.join().expect("second install thread"),
			(Some(libc::EACCES), b"second".to_vec())
		);
	}

	#[test]
	fn rename_flags_unsupported_classifies_only_the_missing_primitive_errnos() {
		assert!(rename_flags_unsupported(Some(libc::EINVAL)));
		assert!(rename_flags_unsupported(Some(libc::ENOSYS)));
		assert!(!rename_flags_unsupported(Some(libc::EEXIST)));
		assert!(!rename_flags_unsupported(Some(libc::EXDEV)));
		assert!(!rename_flags_unsupported(Some(libc::EACCES)));
		assert!(!rename_flags_unsupported(None));
	}

	#[test]
	fn file_publish_falls_back_to_linkat_when_rename_flags_unsupported() {
		for unsupported in [libc::EINVAL, libc::ENOSYS] {
			let temporary = TempDir::new();
			let root = temporary.root();
			ensure_managed_directory(&root, "source-parent").expect("create source parent");
			ensure_managed_directory(&root, "destination-parent").expect("create destination parent");
			let contents = b"nfs-published-binding";
			let identity = managed_file(&root, "source-parent/source", contents);
			// Force the renameat2(RENAME_NOREPLACE) primitive to report the flag as
			// unavailable, exactly as an NFS mount does with EINVAL.
			set_retained_publish_faults([RetainedPublishFault::Rename(unsupported)]);
			let result = rename_managed_file_no_replace(
				&root,
				"source-parent/source",
				"destination-parent/destination",
				&identity.dev,
				&identity.ino,
				&identity.size,
				&identity.mtime_ns,
				&identity.ctime_ns,
				&file_digest(contents),
			);
			assert!(
				result.ok,
				"linkat fallback must publish (errno {unsupported}): {:?}",
				result.code
			);
			assert_eq!(result.primitive, "linkat_noreplace");
			assert!(
				!temporary.0.join("source-parent/source").exists(),
				"staging source is removed after the link fallback"
			);
			assert_eq!(
				fs::read(temporary.0.join("destination-parent/destination"))
					.expect("published destination"),
				contents
			);
			let published = fs::metadata(temporary.0.join("destination-parent/destination"))
				.expect("published destination metadata");
			assert_eq!(
				std::os::unix::fs::MetadataExt::nlink(&published),
				1,
				"published file is single-linked, matching a rename"
			);
		}
	}

	#[test]
	fn install_receipt_names_linkat_fallback_primitive() {
		let temporary = TempDir::new();
		let root = temporary.root();
		managed_file(&root, "source", b"payload");
		set_retained_publish_faults([RetainedPublishFault::Rename(libc::EINVAL)]);

		let result = install(&root, "source", "destination");

		assert!(result.ok, "linkat fallback must install: {:?}", result.code);
		assert_eq!(result.primitive, "linkat_noreplace");
		assert!(!temporary.0.join("source").exists());
		assert_eq!(
			fs::read(temporary.0.join("destination")).expect("published destination"),
			b"payload"
		);
	}

	#[test]
	fn linkat_unlink_failures_report_committed_mutation() {
		for operation in ["managed_rename", "install"] {
			let temporary = TempDir::new();
			let root = temporary.root();
			let contents = b"committed-payload";
			let identity = managed_file(&root, "source", contents);
			set_retained_publish_faults([
				RetainedPublishFault::Rename(libc::EINVAL),
				RetainedPublishFault::Unlink(libc::EACCES),
			]);

			let result = if operation == "managed_rename" {
				rename_managed_file_no_replace(
					&root,
					"source",
					"destination",
					&identity.dev,
					&identity.ino,
					&identity.size,
					&identity.mtime_ns,
					&identity.ctime_ns,
					&file_digest(contents),
				)
			} else {
				install(&root, "source", "destination")
			};

			assert!(!result.ok, "{operation} must surface the failed staging unlink");
			assert_eq!(result.code.as_deref(), Some("io_error"));
			assert_eq!(result.mutation_state, "committed");
			assert_eq!(result.durability_state, "not_provable");
			assert_eq!(result.reason, "io_failure");
			assert_eq!(result.primitive, "linkat_noreplace");
			assert_eq!(result.phase, "source_unlink");
			assert_eq!(result.diagnostic.os_code, Some(libc::EACCES));
			assert!(temporary.0.join("source").exists(), "failed unlink retains staging evidence");
			assert_eq!(
				fs::read(temporary.0.join("destination")).expect("committed destination"),
				contents
			);
		}
	}

	#[test]
	fn linkat_fallback_still_refuses_to_overwrite_an_existing_destination() {
		let temporary = TempDir::new();
		let root = temporary.root();
		ensure_managed_directory(&root, "source-parent").expect("create source parent");
		ensure_managed_directory(&root, "destination-parent").expect("create destination parent");
		let contents = b"candidate";
		let identity = managed_file(&root, "source-parent/source", contents);
		// A distinct committed transcript already owns the destination name.
		fs::write(temporary.0.join("destination-parent/destination"), b"committed")
			.expect("seed committed destination");
		set_retained_publish_faults([RetainedPublishFault::Rename(libc::EINVAL)]);
		let result = rename_managed_file_no_replace(
			&root,
			"source-parent/source",
			"destination-parent/destination",
			&identity.dev,
			&identity.ino,
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(contents),
		);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("already_exists"));
		assert_eq!(result.reason, "destination_exists");
		assert_eq!(result.mutation_state, "not_committed");
		// Neither the staging source nor the committed destination is disturbed.
		assert_eq!(
			fs::read(temporary.0.join("source-parent/source")).expect("source retained"),
			contents
		);
		assert_eq!(
			fs::read(temporary.0.join("destination-parent/destination"))
				.expect("committed destination untouched"),
			b"committed"
		);
	}

	/// Opt-in check that the `linkat(2)` no-replace fallback is atomic on a real
	/// filesystem whose `renameat2` rejects `RENAME_NOREPLACE` (e.g. an `NFSv4`
	/// home directory). Point `GJC_TEST_NFS_DIR` at a writable directory on such
	/// a mount. Exercises the raw fallback helper directly so it is independent
	/// of the owner-only ACL probe.
	#[test]
	fn linkat_no_replace_is_atomic_on_a_real_filesystem() {
		let Some(base) = std::env::var_os("GJC_TEST_NFS_DIR") else {
			return;
		};
		let dir = PathBuf::from(base).join(format!(
			"pi-recovery-fs-linkat-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("clock before epoch")
				.as_nanos(),
		));
		fs::create_dir(&dir).expect("create real-filesystem test root");
		let parent = File::open(&dir).expect("open real-filesystem root");
		let source_name = CString::new("source").expect("source name");
		let destination_name = CString::new("destination").expect("destination name");

		fs::write(dir.join("source"), b"payload").expect("seed source");
		linkat_no_replace(&parent, &source_name, &parent, &destination_name, || ())
			.expect("link publish on the real filesystem");
		assert_eq!(fs::read(dir.join("destination")).expect("published destination"), b"payload");
		assert!(!dir.join("source").exists(), "staging source removed after publish");

		fs::write(dir.join("collision"), b"other").expect("seed collision source");
		let collision_name = CString::new("collision").expect("collision name");
		let error = linkat_no_replace(&parent, &collision_name, &parent, &destination_name, || ())
			.expect_err("no-replace must refuse an existing destination");
		assert_eq!(error.raw_os_error(), Some(libc::EEXIST));
		assert!(dir.join("collision").exists(), "source is untouched on collision");
		assert_eq!(
			fs::read(dir.join("destination")).expect("destination unchanged on collision"),
			b"payload"
		);

		let _ = fs::remove_dir_all(&dir);
	}

	/// The staged descriptor must be released between the publishing link and
	/// the staging unlink. Releasing earlier would publish without descriptor
	/// authority; releasing later is exactly what leaves a silly-renamed sibling
	/// on NFS. This pins that order deterministically on any filesystem, so the
	/// contract is covered without depending on an external mount.
	#[test]
	fn linkat_fallback_releases_source_authority_between_link_and_unlink() {
		let temporary = TempDir::new();
		let parent = temporary.root();
		let source_name = CString::new("source").expect("source name");
		let destination_name = CString::new("destination").expect("destination name");
		fs::write(temporary.0.join("source"), b"payload").expect("seed source");

		let observed = Cell::new(None);
		linkat_no_replace(&parent, &source_name, &parent, &destination_name, || {
			observed.set(Some((
				temporary.0.join("destination").exists(),
				temporary.0.join("source").exists(),
			)));
		})
		.expect("link publish");

		assert_eq!(
			observed.get(),
			Some((true, true)),
			"authority must be released after the destination is published and before the staging \
			 name is unlinked"
		);
		assert!(!temporary.0.join("source").exists(), "staging name removed after release");
	}

	/// Opt-in end-to-end regression for the managed publish path on a filesystem
	/// whose `renameat2` rejects `RENAME_NOREPLACE`. Point `GJC_TEST_NFS_DIR` at
	/// a writable directory on such a mount (e.g. an `NFSv4` home directory).
	///
	/// Unlike `linkat_no_replace_is_atomic_on_a_real_filesystem`, which
	/// exercises the raw helper with no descriptor open, this drives the whole
	/// publish. That distinction is the defect: the publish path held the
	/// staging descriptor open across the fallback, so `unlinkat` silly-renamed
	/// the staging name to `.nfsXXXX` instead of removing it. The published
	/// inode kept a second link, the terminal re-open rejected it as
	/// `hard_link`, and a committed publish was reported as
	/// `rollback_unavailable` — crashing startup on every NFS home.
	#[test]
	fn managed_publish_commits_on_a_filesystem_without_rename_flags() {
		let Some(base) = std::env::var_os("GJC_TEST_NFS_DIR") else {
			return;
		};
		let dir = PathBuf::from(base).join(format!(
			"pi-recovery-fs-publish-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("clock before epoch")
				.as_nanos(),
		));
		fs::create_dir(&dir).expect("create real-filesystem test root");
		fs::set_permissions(
			&dir,
			<fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o700),
		)
		.expect("restrict real-filesystem test root");
		let root = File::open(&dir).expect("open real-filesystem root");

		// Prove this mount actually lacks renameat2 rename flags. Without it the
		// test would also pass on a filesystem where `RENAME_NOREPLACE` works and
		// the `linkat` fallback — the whole point of this case — is never reached.
		fs::write(dir.join("probe-source"), b"probe").expect("seed probe source");
		let probe_error = renameat2_no_replace(
			&root,
			&CString::new("probe-source").expect("probe source name"),
			&root,
			&CString::new("probe-destination").expect("probe destination name"),
		)
		.expect_err(
			"GJC_TEST_NFS_DIR must point at a filesystem whose renameat2 rejects RENAME_NOREPLACE",
		);
		assert!(
			rename_flags_unsupported(probe_error.raw_os_error()),
			"GJC_TEST_NFS_DIR must point at a filesystem without renameat2 rename flags (errno {:?})",
			probe_error.raw_os_error()
		);
		fs::remove_file(dir.join("probe-source")).expect("remove probe source");

		let contents = b"binding";
		let identity = managed_file(&root, "staged", contents);
		let result = rename_managed_file_no_replace(
			&root,
			"staged",
			"published",
			&identity.dev,
			&identity.ino,
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(contents),
		);

		assert!(
			result.ok,
			"publish must commit and prove itself (code={:?} reason={} phase={})",
			result.code, result.reason, result.phase
		);
		assert_eq!(result.reason, "none");
		assert_eq!(result.phase, "complete");
		assert_eq!(result.mutation_state, "committed");
		assert_eq!(result.durability_state, "proven");
		assert_eq!(fs::read(dir.join("published")).expect("published contents"), contents);
		let published =
			fs::symlink_metadata(dir.join("published")).expect("published destination metadata");
		assert_eq!(
			std::os::unix::fs::MetadataExt::nlink(&published),
			1,
			"no silly-renamed staging sibling may survive the publish"
		);
		assert!(!dir.join("staged").exists(), "staging name removed after publish");

		let _ = fs::remove_dir_all(&dir);
	}

	/// Opt-in companion to the publish case: detaching must survive the same
	/// filesystem. `remove_managed` holds its authority descriptor across the
	/// quarantine publish; if it were still open at the staging unlink, NFS
	/// would silly-rename that name, leave the detached object double-linked,
	/// and every proof afterwards would fail as `rollback_unavailable`.
	///
	/// That failure is not cosmetic. The session layer calls this to reconcile a
	/// staged file after a publish that legitimately lost the no-replace race,
	/// and it throws the detach code in place of the benign
	/// `destination_conflict`, which surfaces as `binding_invalid` and crashes
	/// startup on every launch after the first in a given scope.
	#[test]
	fn managed_remove_detaches_on_a_filesystem_without_rename_flags() {
		let Some(base) = std::env::var_os("GJC_TEST_NFS_DIR") else {
			return;
		};
		let dir = PathBuf::from(base).join(format!(
			"pi-recovery-fs-detach-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("clock before epoch")
				.as_nanos(),
		));
		fs::create_dir(&dir).expect("create real-filesystem test root");
		fs::set_permissions(
			&dir,
			<fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o700),
		)
		.expect("restrict real-filesystem test root");
		let root = File::open(&dir).expect("open real-filesystem root");

		fs::write(dir.join("probe-source"), b"probe").expect("seed probe source");
		let probe_error = renameat2_no_replace(
			&root,
			&CString::new("probe-source").expect("probe source name"),
			&root,
			&CString::new("probe-destination").expect("probe destination name"),
		)
		.expect_err(
			"GJC_TEST_NFS_DIR must point at a filesystem whose renameat2 rejects RENAME_NOREPLACE",
		);
		assert!(
			rename_flags_unsupported(probe_error.raw_os_error()),
			"GJC_TEST_NFS_DIR must point at a filesystem without renameat2 rename flags (errno {:?})",
			probe_error.raw_os_error()
		);
		fs::remove_file(dir.join("probe-source")).expect("remove probe source");

		let contents = b"staged";
		let identity = managed_file(&root, "staged", contents);
		let result = remove_managed(
			&root,
			None,
			"staged",
			&identity.dev,
			&identity.ino,
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(contents),
		)
		.expect("detach must not fail on a filesystem without rename flags");

		// A retained detach reports `cleanup_pending` with recovery evidence; the
		// regression reported `rollback_unavailable` through the Err arm above.
		assert_eq!(result.code.as_deref(), Some("cleanup_pending"));
		assert!(result.recovery_path.is_some(), "detach must retain recovery evidence");
		assert!(!dir.join("staged").exists(), "staging name removed after detach");

		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn list_regular_descendants_bounds_enumeration_before_sorting() {
		let temporary = TempDir::new();
		let root = temporary.root();
		managed_file(&root, "z", b"z");
		managed_file(&root, "a", b"a");

		let mut entries = 0;
		let mut paths = Vec::new();
		list_regular_descendants(&root, "", 0, 2, &mut entries, &mut paths)
			.expect("a listing at the cap must succeed");
		assert_eq!(paths, vec!["a".to_owned(), "z".to_owned()]);

		let mut entries = 0;
		let mut paths = Vec::new();
		let error = list_regular_descendants(&root, "", 0, 1, &mut entries, &mut paths)
			.expect_err("a listing beyond the cap must fail closed");
		assert_eq!(error, "entry_limit_exceeded");
		assert_eq!(entries, 2);
		assert!(paths.is_empty(), "over-cap enumeration must not process a sorted prefix");
	}

	/// Seed a small directory tree and return its captured snapshot.
	fn managed_tree(root: &File, path: &str) -> crate::path_identity::NativeDirectoryTreeSnapshot {
		ensure_managed_directory(root, path).expect("create tree root");
		ensure_managed_directory(root, &format!("{path}/nested")).expect("create nested directory");
		managed_file(root, &format!("{path}/nested/leaf"), b"leaf-contents");
		snapshot_managed_tree(root, path)
			.expect("snapshot tree")
			.snapshot
			.expect("tree snapshot present")
	}

	/// `linkat` cannot hard-link a directory, so the file fallback does not
	/// reach tree publishes; `mkdirat` supplies the missing exclusivity
	/// instead. Without this fallback a managed fork of a session that owns
	/// artifacts fails on every mount whose `renameat2` rejects rename flags.
	#[test]
	fn tree_publish_falls_back_to_mkdirat_when_rename_flags_unsupported() {
		for unsupported in [libc::EINVAL, libc::ENOSYS] {
			let temporary = TempDir::new();
			let root = temporary.root();
			ensure_managed_directory(&root, "source-parent").expect("create source parent");
			ensure_managed_directory(&root, "destination-parent").expect("create destination parent");
			let expected = managed_tree(&root, "source-parent/tree");

			// Force the renameat2(RENAME_NOREPLACE) primitive to report the flag as
			// unavailable, exactly as an NFS mount does with EINVAL.
			set_retained_publish_faults([RetainedPublishFault::Rename(unsupported)]);
			let result = rename_managed_tree_no_replace(
				&root,
				"source-parent/tree",
				"destination-parent/tree",
				&expected,
			);

			assert!(
				result.ok,
				"mkdirat fallback must publish the tree (errno {unsupported}): {:?}",
				result.code
			);
			assert_eq!(result.primitive, "mkdirat_renameat_noreplace");
			assert!(
				!temporary.0.join("source-parent/tree").exists(),
				"staging tree is removed after the fallback publish"
			);
			assert_eq!(
				fs::read(temporary.0.join("destination-parent/tree/nested/leaf"))
					.expect("published leaf"),
				b"leaf-contents",
				"the published tree must carry the staged contents"
			);
		}
	}

	/// The guarantee the fallback exists to preserve. `mkdirat` fails with
	/// `EEXIST` exactly where `RENAME_NOREPLACE` would, so standing in for the
	/// missing primitive never authorizes an overwrite.
	#[test]
	fn tree_fallback_still_refuses_to_overwrite_an_existing_destination() {
		let temporary = TempDir::new();
		let root = temporary.root();
		ensure_managed_directory(&root, "source-parent").expect("create source parent");
		ensure_managed_directory(&root, "destination-parent").expect("create destination parent");
		let expected = managed_tree(&root, "source-parent/tree");
		// A distinct committed tree already owns the destination name.
		managed_tree(&root, "destination-parent/tree");

		set_retained_publish_faults([RetainedPublishFault::Rename(libc::EINVAL)]);
		let result = rename_managed_tree_no_replace(
			&root,
			"source-parent/tree",
			"destination-parent/tree",
			&expected,
		);

		assert!(!result.ok, "an occupied destination must never be published over");
		assert_eq!(result.code.as_deref(), Some("already_exists"));
		assert_eq!(
			fs::read(temporary.0.join("destination-parent/tree/nested/leaf"))
				.expect("occupying leaf survives"),
			b"leaf-contents",
			"the occupying tree must be left untouched"
		);
		assert!(
			temporary.0.join("source-parent/tree").exists(),
			"a rejected publish leaves the staging tree in place"
		);
	}

	/// The name claim and the rename are two steps, so a rename that fails after
	/// the claim must give the destination name back rather than leave an empty
	/// directory squatting it.
	#[test]
	fn tree_fallback_removes_its_placeholder_when_the_rename_fails() {
		let temporary = TempDir::new();
		let root = temporary.root();

		let error = rename_directory_no_replace(
			&root,
			&CString::new("absent-source").expect("source name"),
			&root,
			&CString::new("destination").expect("destination name"),
		)
		.expect_err("renaming an absent source must fail");

		assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
		assert!(
			!temporary.0.join("destination").exists(),
			"a failed rename must not leave its placeholder behind"
		);
	}

	/// `remove_managed_tree` quarantines through the same directory no-replace
	/// primitive, so staging-tree cleanup is blocked on the same mounts the
	/// publish was. Fixing only the publish leaves a fork that fails mid-flight
	/// unable to clean up after itself.
	#[test]
	fn managed_remove_tree_detaches_on_a_filesystem_without_rename_flags() {
		let temporary = TempDir::new();
		let root = temporary.root();
		let expected = managed_tree(&root, "staged-tree");

		set_retained_publish_faults([RetainedPublishFault::Rename(libc::EINVAL)]);
		let result = remove_managed_tree(&root, None, "staged-tree", &expected)
			.expect("detach must not fail on a filesystem without rename flags");

		assert_eq!(result.code.as_deref(), Some("cleanup_pending"));
		assert!(result.recovery_path.is_some(), "detach must retain recovery evidence");
		assert!(
			!temporary.0.join("staged-tree").exists(),
			"canonical tree name removed after detach"
		);
	}

	/// `replace_managed` reaches `RENAME_EXCHANGE` directly. Without a fallback
	/// every managed replacement fails on a mount that implements no rename
	/// flags, and that is an ordinary in-session path — the session transcript
	/// rewrite (`#persistPatch` / `#rewriteFile`) goes through it — not a
	/// migration-only one.
	#[test]
	fn managed_replace_falls_back_to_linkat_when_rename_flags_unsupported() {
		for unsupported in [libc::EINVAL, libc::ENOSYS] {
			let temporary = TempDir::new();
			let root = temporary.root();
			let original = b"original-transcript";
			let identity = managed_file(&root, "transcript", original);
			let replacement = b"rewritten-transcript";

			// Force the renameat2(RENAME_EXCHANGE) primitive to report the flag as
			// unavailable, exactly as an NFS mount does with EINVAL.
			set_retained_publish_faults([RetainedPublishFault::Rename(unsupported)]);
			let result = replace_managed(
				&root,
				None,
				"transcript",
				replacement,
				&identity.dev,
				&identity.ino,
				&identity.size,
				&identity.mtime_ns,
				&identity.ctime_ns,
				&file_digest(original),
			);

			assert!(result.ok, "link fallback must publish (errno {unsupported}): {:?}", result.code);
			assert_eq!(
				fs::read(temporary.0.join("transcript")).expect("published transcript"),
				replacement,
				"the destination must carry the replacement contents"
			);
			let published = fs::metadata(temporary.0.join("transcript")).expect("published metadata");
			assert_eq!(
				std::os::unix::fs::MetadataExt::nlink(&published),
				1,
				"the published replacement is single-linked, matching an exchange"
			);

			// The exchange leaves the displaced object under the candidate name as
			// rollback evidence; the fallback must reach the same terminal state.
			let displaced = fs::read_dir(temporary.0.join(".gjc-recovery"))
				.expect("recovery directory")
				.filter_map(Result::ok)
				.find(|entry| {
					entry
						.file_name()
						.to_string_lossy()
						.starts_with(".gjc-managed-replace-")
				})
				.expect("displaced object retained under the candidate name");
			assert_eq!(
				fs::read(displaced.path()).expect("displaced contents"),
				original,
				"the displaced object must still hold the replaced contents"
			);
			assert_eq!(
				std::os::unix::fs::MetadataExt::nlink(
					&fs::metadata(displaced.path()).expect("displaced metadata")
				),
				1,
				"the displaced object is single-linked, matching an exchange"
			);
			// The fallback's temporary name is an implementation detail and must not
			// survive a successful replacement.
			assert!(
				!fs::read_dir(temporary.0.join(".gjc-recovery"))
					.expect("recovery directory")
					.filter_map(Result::ok)
					.any(|entry| entry
						.file_name()
						.to_string_lossy()
						.starts_with(".gjc-managed-exchange-")),
				"no temporary exchange name may survive"
			);
		}
	}

	#[test]
	fn managed_replace_rechecks_destination_at_exchange_boundary() {
		let temporary = TempDir::new();
		let root = temporary.root();
		let original = b"authorized-transcript";
		let identity = managed_file(&root, "transcript", original);
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		set_replacement_before_exchange_hook(Some((entered_tx, resume_rx)));

		let root_for_replace = root.try_clone().expect("clone retained root");
		let dev = identity.dev.clone();
		let ino = identity.ino.clone();
		let size = identity.size.clone();
		let mtime_ns = identity.mtime_ns.clone();
		let ctime_ns = identity.ctime_ns.clone();
		let replace = std::thread::spawn(move || {
			replace_managed(
				&root_for_replace,
				None,
				"transcript",
				b"replacement",
				&dev,
				&ino,
				&size,
				&mtime_ns,
				&ctime_ns,
				&file_digest(original),
			)
		});
		entered_rx.recv().expect("wait for exchange boundary");
		fs::rename(temporary.0.join("transcript"), temporary.0.join("authorized"))
			.expect("retain predecessor");
		fs::write(temporary.0.join("transcript"), b"concurrent-successor")
			.expect("publish successor");
		resume_tx.send(()).expect("resume exchange boundary");
		let result = replace.join().expect("replacement thread");
		set_replacement_before_exchange_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.mutation_state, "not_committed");
		assert_eq!(result.durability_state, "not_attempted");
		assert_eq!(
			fs::read(temporary.0.join("transcript")).expect("successor"),
			b"concurrent-successor"
		);
		assert_eq!(fs::read(temporary.0.join("authorized")).expect("predecessor"), original);
	}

	#[test]
	fn managed_replace_reports_post_exchange_failure_as_committed() {
		let temporary = TempDir::new();
		let root = temporary.root();
		let original = b"original-transcript";
		let identity = managed_file(&root, "transcript", original);
		set_retained_publish_faults([RetainedPublishFault::PostExchange("io_error")]);

		let result = replace_managed(
			&root,
			None,
			"transcript",
			b"rewritten-transcript",
			&identity.dev,
			&identity.ino,
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(original),
		);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("io_error"));
		assert_eq!(result.mutation_state, "committed");
		assert_eq!(result.durability_state, "not_provable");
		assert_eq!(result.reason, "io_failure");
		assert_eq!(result.phase, "terminal_identity");
		let identity = result
			.identity
			.as_ref()
			.expect("committed replacement identity");
		let expected_digest = file_digest(b"rewritten-transcript");
		assert_eq!(identity.sha256.as_deref(), Some(expected_digest.as_str()));
		assert_eq!(
			fs::read(temporary.0.join("transcript")).expect("replacement"),
			b"rewritten-transcript"
		);
	}

	/// The ordering that makes the fallback safe on NFS, pinned
	/// deterministically on any filesystem: the displaced object must already
	/// be reachable through the rollback link when authority is released, and
	/// the destination must not yet have been replaced.
	#[test]
	fn replacement_fallback_releases_authority_between_rollback_link_and_rename() {
		let temporary = TempDir::new();
		let parent = temporary.root();
		fs::write(temporary.0.join("destination"), b"old").expect("seed destination");
		fs::write(temporary.0.join("candidate"), b"new").expect("seed candidate");
		let candidate_name = CString::new("candidate").expect("candidate name");
		let destination_name = CString::new("destination").expect("destination name");

		let observed = Cell::new(None);
		exchange_through_link(
			&parent,
			&candidate_name,
			&parent,
			&destination_name,
			|| {
				let rollback = fs::read_dir(&temporary.0)
					.expect("read parent")
					.filter_map(Result::ok)
					.any(|entry| {
						entry
							.file_name()
							.to_string_lossy()
							.starts_with(".gjc-managed-exchange-")
					});
				let destination =
					fs::read(temporary.0.join("destination")).expect("destination still present");
				observed.set(Some((rollback, destination == b"old")));
			},
			|| Ok(()),
		)
		.expect("link exchange");

		assert_eq!(
			observed.get(),
			Some((true, true)),
			"authority must be released once the displaced object has a rollback link and before the \
			 destination is replaced"
		);
		assert_eq!(fs::read(temporary.0.join("destination")).expect("destination"), b"new");
		assert_eq!(fs::read(temporary.0.join("candidate")).expect("candidate"), b"old");
	}

	/// The crash boundary. A three-step emulation is only equivalent to
	/// `RENAME_EXCHANGE` if the displaced object can never lose its last name,
	/// so the rollback link must be durable *before* anything is displaced.
	/// When that durability cannot be proven the call must fail closed with
	/// nothing published, rather than commit a replacement whose rollback
	/// evidence might never reach the disk.
	#[test]
	fn replacement_fallback_fails_closed_when_the_rollback_link_is_not_durable() {
		let temporary = TempDir::new();
		let root = temporary.root();
		let original = b"original-transcript";
		let identity = managed_file(&root, "transcript", original);

		// Force the exchange primitive to report the flag as unavailable, then fail
		// the rollback link's parent sync — the boundary between the link and the
		// destructive rename.
		set_retained_publish_faults([
			RetainedPublishFault::Rename(libc::EINVAL),
			RetainedPublishFault::Sync(Some(libc::EIO)),
		]);
		let failure = replace_managed(
			&root,
			None,
			"transcript",
			b"rewritten-transcript",
			&identity.dev,
			&identity.ino,
			&identity.size,
			&identity.mtime_ns,
			&identity.ctime_ns,
			&file_digest(original),
		);

		assert!(!failure.ok);
		assert_eq!(failure.code.as_deref(), Some("durability_not_provable"));
		assert_eq!(failure.mutation_state, "not_committed");
		assert_eq!(
			fs::read(temporary.0.join("transcript")).expect("destination"),
			original,
			"nothing may be displaced when the rollback link is not durable"
		);
		assert!(
			!fs::read_dir(temporary.0.join(".gjc-recovery"))
				.expect("recovery directory")
				.filter_map(Result::ok)
				.any(|entry| entry
					.file_name()
					.to_string_lossy()
					.starts_with(".gjc-managed-exchange-")),
			"the unprovable rollback link must be removed"
		);
	}

	/// Cross-parent post-publication sync failures retain their phase-specific
	/// classification and never discard the displaced recovery evidence.
	#[test]
	fn replacement_fallback_classifies_cross_parent_sync_failures() {
		let temporary = TempDir::new();
		let source_parent_path = temporary.0.join("recovery");
		let destination_parent_path = temporary.0.join("destination");
		fs::create_dir_all(&source_parent_path).expect("create recovery parent");
		fs::create_dir_all(&destination_parent_path).expect("create destination parent");
		fs::write(source_parent_path.join("candidate"), b"new").expect("seed candidate");
		fs::write(destination_parent_path.join("destination"), b"old").expect("seed destination");
		let source_parent = File::open(&source_parent_path).expect("open recovery parent");
		let destination_parent =
			File::open(&destination_parent_path).expect("open destination parent");
		let candidate_name = CString::new("candidate").expect("candidate name");
		let destination_name = CString::new("destination").expect("destination name");

		set_retained_publish_faults([
			RetainedPublishFault::Sync(None),
			RetainedPublishFault::Sync(Some(libc::EIO)),
		]);
		let destination_error = exchange_through_link(
			&source_parent,
			&candidate_name,
			&destination_parent,
			&destination_name,
			|| {},
			|| Ok(()),
		)
		.expect_err("destination-parent sync failure must be reported");
		assert!(matches!(destination_error, ReplacementExchangeError::PostMutation {
			code: "fsync_failed",
			phase: "destination_parent_sync",
			..
		}));
		assert_eq!(fs::read(destination_parent_path.join("destination")).unwrap(), b"new");
		assert!(
			fs::read_dir(&source_parent_path)
				.unwrap()
				.filter_map(Result::ok)
				.any(|entry| entry
					.file_name()
					.to_string_lossy()
					.starts_with(".gjc-managed-exchange-")),
			"rollback evidence must remain after destination sync failure"
		);

		fs::write(source_parent_path.join("candidate"), b"new").expect("reseeding candidate");
		fs::write(destination_parent_path.join("destination"), b"old")
			.expect("reseeding destination");
		set_retained_publish_faults([
			RetainedPublishFault::Sync(None),
			RetainedPublishFault::Sync(None),
			RetainedPublishFault::Sync(Some(libc::EACCES)),
		]);
		let candidate_error = exchange_through_link(
			&source_parent,
			&candidate_name,
			&destination_parent,
			&destination_name,
			|| {},
			|| Ok(()),
		)
		.expect_err("candidate-parent sync failure must be reported");
		assert!(matches!(candidate_error, ReplacementExchangeError::PostMutation {
			code: "fsync_failed",
			phase: "source_parent_sync",
			..
		}));
		assert_eq!(fs::read(destination_parent_path.join("destination")).unwrap(), b"new");
		assert_eq!(fs::read(source_parent_path.join("candidate")).unwrap(), b"old");
	}

	/// A replacement that cannot publish must leave the namespace exactly as it
	/// was found, including the rollback link the fallback created.
	#[test]
	fn replacement_fallback_removes_its_rollback_link_when_the_rename_fails() {
		let temporary = TempDir::new();
		let parent = temporary.root();
		fs::write(temporary.0.join("destination"), b"old").expect("seed destination");
		let candidate_name = CString::new("absent-candidate").expect("candidate name");
		let destination_name = CString::new("destination").expect("destination name");

		exchange_through_link(&parent, &candidate_name, &parent, &destination_name, || {}, || Ok(()))
			.expect_err("replacing from an absent candidate must fail");

		assert_eq!(
			fs::read(temporary.0.join("destination")).expect("destination"),
			b"old",
			"a failed replacement must leave the destination untouched"
		);
		assert!(
			!fs::read_dir(&temporary.0)
				.expect("read parent")
				.filter_map(Result::ok)
				.any(|entry| entry
					.file_name()
					.to_string_lossy()
					.starts_with(".gjc-managed-exchange-")),
			"a failed replacement must not leave its rollback link behind"
		);
	}
}
