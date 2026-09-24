//! Linux-only descriptor-relative filesystem authority for crash recovery.
//!
//! Every operation is rooted in the directory descriptor acquired by
//! [`open_recovery_fs_root`]. Relative names are walked one component at a
//! time without following symlinks, and regular files must be single-linked.

#[cfg(all(test, target_os = "linux"))]
use std::{cell::RefCell, collections::VecDeque};
#[cfg(target_os = "linux")]
use std::{
	ffi::CString,
	fs::File,
	io::{Read, Seek, SeekFrom, Write},
	os::{
		fd::{AsRawFd, FromRawFd},
		unix::{ffi::OsStrExt, fs::MetadataExt},
	},
	path::{Component, Path},
	sync::{
		Arc, OnceLock,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
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
const RECOVERY_REAPER_SWEEP_INTERVAL: Duration = Duration::from_mins(1);
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_CURSOR_NAME: &[u8] = b".gjc-reaper-cursor";
#[cfg(target_os = "linux")]
// Keep each sweep bounded while persisting the directory cookie so a fresh CLI
// process continues past a permanently preserved prefix.
const RECOVERY_REAPER_MAX_SCAN_ENTRIES: usize = 65_536;
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_MAX_FILES: u64 = 64;
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_MAX_BYTES: u64 = 256 * 1024 * 1024;
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_REPLACE_GRACE_SECS: u64 = 2 * 60 * 60;
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_REMOVE_TTL_SECS: u64 = 7 * 24 * 60 * 60;
#[cfg(target_os = "linux")]
const RECOVERY_REAPER_CLOCK_GRACE_SECS: u64 = 5 * 60;

#[cfg(target_os = "linux")]
#[derive(Default)]
struct RecoveryReaperState {
	last_attempt: Option<Instant>,
	last_metrics: RecoveryReaperMetrics,
	totals:       RecoveryReaperTotals,
}

#[cfg(target_os = "linux")]
#[derive(Default)]
struct RecoveryReaperTotals {
	reaped_files: u64,
	reaped_bytes: u64,
	failures:     u64,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct RecoveryReaperMetrics {
	scanned_entries:      u64,
	reaped_files:         u64,
	reaped_bytes:         u64,
	preserved_candidates: u64,
	failures:             u64,
	scan_limited:         bool,
	total_reaped_files:   u64,
	total_reaped_bytes:   u64,
	total_failures:       u64,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ManagedRecoveryName {
	pid:             libc::pid_t,
	publisher:       Option<ManagedPublisherIdentity>,
	kind:            ManagedRecoveryKind,
	created_at_secs: Option<u64>,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ManagedPublisherIdentity {
	pid_namespace:    u64,
	boot_id:          [u8; 16],
	start_time_ticks: u64,
}

#[cfg(target_os = "linux")]
#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LinuxBootInfo {
	boot_id: [u8; 16],
}

#[cfg(target_os = "linux")]
struct RecoveryReaperMarker {
	name:     CString,
	identity: RecoveryFsIdentity,
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ManagedRecoveryKind {
	Replace,
	CompletedReplace,
	Remove,
}

#[cfg(target_os = "linux")]
static MANAGED_REPLACEMENT_ID: AtomicU64 = AtomicU64::new(0);

#[cfg(all(test, target_os = "linux"))]
#[derive(Clone, Copy)]
enum RetainedPublishFault {
	Rename(i32),
	Unlink(i32),
	ReplacementCandidateUnlink(i32),
	Sync(Option<i32>),
	PostRenameSnapshot(&'static str),
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
fn take_replacement_candidate_unlink_fault() -> Option<i32> {
	RETAINED_PUBLISH_FAULTS.with(|configured| {
		let mut configured = configured.borrow_mut();
		match configured.front().copied() {
			Some(RetainedPublishFault::ReplacementCandidateUnlink(code)) => {
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
#[derive(Clone, Copy, Debug)]
enum NoReplacePrimitive {
	Renameat2,
	Linkat,
	MkdiratRenameat,
}

#[cfg(target_os = "linux")]
impl NoReplacePrimitive {
	const fn as_str(self) -> &'static str {
		match self {
			Self::Renameat2 => "renameat2_noreplace",
			Self::Linkat => "linkat_noreplace",
			Self::MkdiratRenameat => "mkdirat_renameat_noreplace",
		}
	}
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
) -> Result<(), &'static str> {
	let temporary = CString::new(format!(
		".gjc-managed-exchange-{}-{}",
		std::process::id(),
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
	))
	.map_err(|_| "io_error")?;
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
		return Err("io_error");
	}
	// Persist the rollback name before anything is displaced. If durability is
	// unprovable, remove the link and fail before publication.
	if sync_parent(candidate_parent).is_err() {
		// SAFETY: the candidate parent fd and temporary name remain valid; this
		// removes only the link created above.
		unsafe { libc::unlinkat(candidate_parent.as_raw_fd(), temporary.as_ptr(), 0) };
		return Err("durability_not_provable");
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
		// removes only the link created above.
		unsafe { libc::unlinkat(candidate_parent.as_raw_fd(), temporary.as_ptr(), 0) };
		return Err("io_error");
	}
	// Publication has committed. Persist the destination-parent mutation before
	// moving the rollback name; a sync failure is committed-but-unproven.
	if sync_parent(destination_parent).is_err() {
		return Err("destination_parent_sync_failed");
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
		return Err("rollback_unavailable");
	}
	// Settle the final rollback name's parent so the terminal namespace is durable.
	if sync_parent(candidate_parent).is_err() {
		return Err("candidate_parent_sync_failed");
	}
	Ok(())
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
) -> Result<(), &'static str> {
	#[cfg(test)]
	if let Some(Some(code)) = take_retained_publish_fault(true) {
		return if rename_flags_unsupported(Some(code)) {
			exchange_through_link(
				candidate_parent,
				candidate_name,
				destination_parent,
				destination_name,
				release_destination_authority,
			)
		} else {
			Err("io_error")
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
		return Ok(());
	}
	if !rename_flags_unsupported(std::io::Error::last_os_error().raw_os_error()) {
		return Err("io_error");
	}
	exchange_through_link(
		candidate_parent,
		candidate_name,
		destination_parent,
		destination_name,
		release_destination_authority,
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
/// Refreshes a fully-written replacement candidate's retention timestamp just
/// before exchange. This preparatory move is not a retained publication and
/// bypasses normal publication fault injection and parent-sync reporting. A
/// dedicated test fault covers the link fallback's source-unlink rollback.
fn rename_replacement_candidate_no_replace(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	release_source_authority: impl FnOnce(),
) -> Result<(), &'static str> {
	#[cfg(test)]
	let injected_unlink_error = take_replacement_candidate_unlink_fault();
	#[cfg(not(test))]
	let injected_unlink_error = None;
	if injected_unlink_error.is_none() {
		// SAFETY: retained parents and validated names make the no-replace syscall
		// operands valid; RENAME_NOREPLACE prevents replacing any existing candidate.
		let renamed = unsafe {
			libc::syscall(
				libc::SYS_renameat2,
				source_parent.as_raw_fd(),
				source_name.as_ptr(),
				destination_parent.as_raw_fd(),
				destination_name.as_ptr(),
				libc::RENAME_NOREPLACE,
			)
		};
		if renamed == 0 {
			return Ok(());
		}
		if !rename_flags_unsupported(std::io::Error::last_os_error().raw_os_error()) {
			return Err("io_error");
		}
	}
	let source_before = statat(source_parent, source_name)?;
	if !reaper_owner_file_stat(&source_before) {
		return Err("identity_mismatch");
	}
	let expected_inode = (source_before.st_dev, source_before.st_ino);
	// SAFETY: retained parents and validated names make the linkat operands valid;
	// linkat fails rather than replacing an existing destination name.
	if unsafe {
		libc::linkat(
			source_parent.as_raw_fd(),
			source_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			0,
		)
	} != 0
	{
		return Err("io_error");
	}
	release_source_authority();
	let source_after_link = statat(source_parent, source_name);
	let destination_after_link = statat(destination_parent, destination_name);
	if !source_after_link
		.as_ref()
		.is_ok_and(|stat| owner_only_two_link_stat_matches(stat, expected_inode))
		|| !destination_after_link
			.as_ref()
			.is_ok_and(|stat| owner_only_two_link_stat_matches(stat, expected_inode))
	{
		if rollback_owner_only_link_pair(
			source_parent,
			source_name,
			destination_parent,
			destination_name,
			expected_inode,
		) {
			return Err("identity_mismatch");
		}
		return Err("rollback_unavailable");
	}
	let unlink_error = if let Some(code) = injected_unlink_error {
		Some(std::io::Error::from_raw_os_error(code))
	} else {
		// SAFETY: the retained source parent and validated source name identify the
		// source link whose inode and destination link were just verified.
		let unlinked = unsafe { libc::unlinkat(source_parent.as_raw_fd(), source_name.as_ptr(), 0) };
		(unlinked != 0).then(std::io::Error::last_os_error)
	};
	if let Some(_unlink_error) = unlink_error {
		if !rollback_owner_only_link_pair(
			source_parent,
			source_name,
			destination_parent,
			destination_name,
			expected_inode,
		) {
			return Err("rollback_unavailable");
		}
		return Err("io_error");
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn owner_only_two_link_stat_matches(stat: &libc::stat, expected_inode: (u64, u64)) -> bool {
	// SAFETY: geteuid has no preconditions and only reads the effective user ID.
	let effective_uid = unsafe { libc::geteuid() };
	(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
		&& stat.st_dev == expected_inode.0
		&& stat.st_ino == expected_inode.1
		&& stat.st_uid == effective_uid
		&& stat.st_mode & 0o7777 == 0o600
		&& stat.st_nlink == 2
}

#[cfg(target_os = "linux")]
fn open_owner_only_link(parent: &File, name: &CString) -> Result<File, &'static str> {
	// SAFETY: the retained parent and validated name constrain the open to one
	// child; O_NOFOLLOW and O_NONBLOCK reject link and FIFO substitutions.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return Err("identity_mismatch");
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn rollback_owner_only_link_pair(
	source_parent: &File,
	source_name: &CString,
	destination_parent: &File,
	destination_name: &CString,
	expected_inode: (u64, u64),
) -> bool {
	let Ok(source_file) = open_owner_only_link(source_parent, source_name) else {
		return false;
	};
	let Ok(destination_file) = open_owner_only_link(destination_parent, destination_name) else {
		return false;
	};
	if crate::path_identity::platform::verify_created_owner_only_file(&source_file).is_err()
		|| crate::path_identity::platform::verify_created_owner_only_file(&destination_file).is_err()
	{
		return false;
	}
	let Ok(source_metadata) = source_file.metadata() else {
		return false;
	};
	let Ok(destination_metadata) = destination_file.metadata() else {
		return false;
	};
	if source_metadata.dev() != expected_inode.0
		|| source_metadata.ino() != expected_inode.1
		|| destination_metadata.dev() != expected_inode.0
		|| destination_metadata.ino() != expected_inode.1
		|| source_metadata.nlink() != 2
		|| destination_metadata.nlink() != 2
	{
		return false;
	}
	let Ok(source_named) = statat(source_parent, source_name) else {
		return false;
	};
	let Ok(destination_named) = statat(destination_parent, destination_name) else {
		return false;
	};
	if !owner_only_two_link_stat_matches(&source_named, expected_inode)
		|| !owner_only_two_link_stat_matches(&destination_named, expected_inode)
	{
		return false;
	}
	// NFS may silly-rename an unlinked file while its descriptor is open.
	drop(source_file);
	drop(destination_file);
	let Ok(source_named) = statat(source_parent, source_name) else {
		return false;
	};
	let Ok(destination_named) = statat(destination_parent, destination_name) else {
		return false;
	};
	if !owner_only_two_link_stat_matches(&source_named, expected_inode)
		|| !owner_only_two_link_stat_matches(&destination_named, expected_inode)
	{
		return false;
	}
	// SAFETY: the destination was exclusively created by this function's linkat;
	// source and destination were revalidated as the expected two links above.
	let unlinked =
		unsafe { libc::unlinkat(destination_parent.as_raw_fd(), destination_name.as_ptr(), 0) };
	if unlinked != 0 {
		return false;
	}
	destination_parent.sync_all().is_ok()
}

#[cfg(target_os = "linux")]
fn rename_reaper_quarantine_no_replace(
	recovery: &File,
	source_name: &CString,
	quarantine_name: &CString,
	expected_identity: &RecoveryFsIdentity,
) -> Result<NoReplacePrimitive, FileNoReplaceError> {
	let source_stat = statat(recovery, source_name)
		.map_err(|_| FileNoReplaceError::PreMutation(std::io::Error::from_raw_os_error(libc::EIO)))?;
	if !reaper_owner_file_stat(&source_stat)
		|| !stat_matches_regular_identity_after_rename(&source_stat, expected_identity)
	{
		return Err(FileNoReplaceError::PreMutation(std::io::Error::from_raw_os_error(libc::EIO)));
	}
	let expected_inode = (source_stat.st_dev, source_stat.st_ino);
	match rename_file_no_replace(recovery, source_name, recovery, quarantine_name, || {}) {
		Err(FileNoReplaceError::PostMutation(error)) => {
			if rollback_owner_only_link_pair(
				recovery,
				source_name,
				recovery,
				quarantine_name,
				expected_inode,
			) {
				Err(FileNoReplaceError::PreMutation(error))
			} else {
				Err(FileNoReplaceError::PostMutation(error))
			}
		},
		result => result,
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
#[derive(Clone, PartialEq, Eq)]

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
	pub ok:       bool,
	pub code:     Option<String>,
	pub identity: Option<RecoveryFsIdentity>,
	pub data:     Option<Uint8Array>,
}

/// Bounded managed-recovery reaper counters. Large counters are decimal strings
/// so JavaScript callers do not lose precision above `Number.MAX_SAFE_INTEGER`.
#[napi(object)]
pub struct RecoveryFsReaperMetrics {
	pub ok:                 bool,
	pub code:               Option<String>,
	pub scanned_entries:    String,
	pub reaped_files:       String,
	pub reaped_bytes:       String,
	pub preserved_entries:  String,
	pub failures:           String,
	pub scan_limited:       bool,
	pub total_reaped_files: String,
	pub total_reaped_bytes: String,
	pub total_failures:     String,
}

#[cfg(target_os = "linux")]
impl RecoveryFsReaperMetrics {
	fn from_reaper_metrics(metrics: RecoveryReaperMetrics) -> Self {
		let ok = metrics.failures == 0;
		Self {
			ok,
			code: (!ok).then(|| "partial_failure".to_owned()),
			scanned_entries: metrics.scanned_entries.to_string(),
			reaped_files: metrics.reaped_files.to_string(),
			reaped_bytes: metrics.reaped_bytes.to_string(),
			preserved_entries: metrics.preserved_candidates.to_string(),
			failures: metrics.failures.to_string(),
			scan_limited: metrics.scan_limited,
			total_reaped_files: metrics.total_reaped_files.to_string(),
			total_reaped_bytes: metrics.total_reaped_bytes.to_string(),
			total_failures: metrics.total_failures.to_string(),
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok:                 false,
			code:               Some(code.to_owned()),
			scanned_entries:    "0".to_owned(),
			reaped_files:       "0".to_owned(),
			reaped_bytes:       "0".to_owned(),
			preserved_entries:  "0".to_owned(),
			failures:           "0".to_owned(),
			scan_limited:       false,
			total_reaped_files: "0".to_owned(),
			total_reaped_bytes: "0".to_owned(),
			total_failures:     "0".to_owned(),
		}
	}
}

#[cfg(not(target_os = "linux"))]
impl RecoveryFsReaperMetrics {
	fn failure(code: &str) -> Self {
		Self {
			ok:                 false,
			code:               Some(code.to_owned()),
			scanned_entries:    "0".to_owned(),
			reaped_files:       "0".to_owned(),
			reaped_bytes:       "0".to_owned(),
			preserved_entries:  "0".to_owned(),
			failures:           "0".to_owned(),
			scan_limited:       false,
			total_reaped_files: "0".to_owned(),
			total_reaped_bytes: "0".to_owned(),
			total_failures:     "0".to_owned(),
		}
	}
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
		Self { ok: true, code: None, identity: Some(identity), data: None }
	}

	#[cfg(target_os = "linux")]
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
	let mut result = publish_post_mutation_failure(code, phase);
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
	root:           Mutex<Option<File>>,
	#[cfg(target_os = "linux")]
	recovery:       Mutex<Option<File>>,
	#[cfg(target_os = "linux")]
	recovery_error: Option<&'static str>,
	#[cfg(target_os = "linux")]
	reaper:         Arc<Mutex<RecoveryReaperState>>,
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

	/// Return the latest bounded managed-recovery sweep metrics and lifetime
	/// removal counters. The per-root sweep remains throttled to once per
	/// minute.
	#[napi]
	pub fn recovery_reaper_metrics(&self) -> RecoveryFsReaperMetrics {
		#[cfg(target_os = "linux")]
		{
			let root_guard = self.root.lock();
			let Some(_root) = root_guard.as_ref() else {
				return RecoveryFsReaperMetrics::failure("closed");
			};
			if let Some(code) = self.recovery_error {
				return RecoveryFsReaperMetrics::failure(code);
			}
			let recovery_guard = self.recovery.lock();
			if let Some(recovery) = recovery_guard.as_ref() {
				let _ = reap_managed_recovery_if_due(recovery, &self.reaper);
			}
			let state = self.reaper.lock();
			RecoveryFsReaperMetrics::from_reaper_metrics(state.last_metrics)
		}
		#[cfg(not(target_os = "linux"))]
		RecoveryFsReaperMetrics::failure("unsupported_platform")
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
			let _ = reap_managed_recovery_if_due(&recovery, &self.reaper);
			Ok(Self {
				root:           Mutex::new(Some(directory)),
				recovery:       Mutex::new(Some(recovery)),
				recovery_error: self.recovery_error,
				reaper:         Arc::clone(&self.reaper),
			})
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
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery(&self.root, &self.recovery, &self.reaper, |root, recovery| {
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
			RecoveryFsResult::failure("unsupported_platform")
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
			with_root_and_recovery_cleanup(
				&self.root,
				&self.recovery,
				&self.reaper,
				|root, recovery| {
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
				},
			)
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
			with_root_and_recovery_cleanup(
				&self.root,
				&self.recovery,
				&self.reaper,
				|root, recovery| remove_managed_tree(root, recovery, &relative_path, &expected),
			)
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
		let reaper = Arc::new(Mutex::new(RecoveryReaperState::default()));
		let mut recovery_error = None;
		let recovery = match open_existing_directory(&root, ".gjc-recovery") {
			Ok(recovery) => {
				if crate::path_identity::platform::verify_retained_owner_only_directory(&recovery)
					.is_ok()
				{
					let _ = reap_managed_recovery(&recovery, &reaper, true);
					Some(recovery)
				} else {
					recovery_error = Some("recovery_directory_unavailable");
					None
				}
			},
			Err("not_found") => None,
			Err(_) => {
				recovery_error = Some("recovery_directory_unavailable");
				None
			},
		};
		Ok(RecoveryFsRoot {
			root: Mutex::new(Some(root)),
			recovery: Mutex::new(recovery),
			recovery_error,
			reaper,
		})
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
	reaper: &Arc<Mutex<RecoveryReaperState>>,
	operation: impl FnOnce(&File, Option<&File>) -> Result<RecoveryFsRetainedCleanupResult, &'static str>,
) -> RecoveryFsRetainedCleanupResult {
	let root_guard = root.lock();
	let Some(root) = root_guard.as_ref() else {
		return RecoveryFsRetainedCleanupResult::failure("closed");
	};
	let mut recovery_guard = recovery.lock();
	let result = if let Some(directory) = recovery_guard.as_ref() {
		let _metrics = reap_managed_recovery_if_due(directory, reaper);
		operation(root, Some(directory))
	} else {
		let result = operation(root, None);
		if let Ok(directory) = open_existing_directory(root, ".gjc-recovery")
			&& crate::path_identity::platform::verify_retained_owner_only_directory(&directory).is_ok()
		{
			if let Ok(cached) = directory.try_clone() {
				*recovery_guard = Some(cached);
			}
			let _metrics = reap_managed_recovery_if_due(&directory, reaper);
		}
		result
	};
	result.unwrap_or_else(RecoveryFsRetainedCleanupResult::failure)
}

#[cfg(target_os = "linux")]
fn with_root_and_recovery(
	root: &Mutex<Option<File>>,
	recovery: &Mutex<Option<File>>,
	reaper: &Arc<Mutex<RecoveryReaperState>>,
	operation: impl FnOnce(&File, Option<&File>) -> Result<RecoveryFsResult, &'static str>,
) -> RecoveryFsResult {
	let root_guard = root.lock();
	let Some(root) = root_guard.as_ref() else {
		return RecoveryFsResult::failure("closed");
	};
	let mut recovery_guard = recovery.lock();
	let result = if let Some(directory) = recovery_guard.as_ref() {
		let _metrics = reap_managed_recovery_if_due(directory, reaper);
		operation(root, Some(directory))
	} else {
		let result = operation(root, None);
		if let Ok(directory) = open_existing_directory(root, ".gjc-recovery")
			&& crate::path_identity::platform::verify_retained_owner_only_directory(&directory).is_ok()
		{
			if let Ok(cached) = directory.try_clone() {
				*recovery_guard = Some(cached);
			}
			let _metrics = reap_managed_recovery_if_due(&directory, reaper);
		}
		result
	};
	result.unwrap_or_else(RecoveryFsResult::failure)
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
		return Err(if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
			"not_found"
		} else {
			"io_error"
		});
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
fn stat_matches_regular_identity_after_rename(
	stat: &libc::stat,
	identity: &RecoveryFsIdentity,
) -> bool {
	(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
		&& stat.st_nlink == 1
		&& stat.st_dev.to_string() == identity.dev
		&& stat.st_ino.to_string() == identity.ino
		&& (stat.st_size as u64).to_string() == identity.size
		&& stat_mtime_ns(stat).to_string() == identity.mtime_ns
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
fn managed_recovery_name(family: &str, counter: u64) -> Result<String, &'static str> {
	let created_at_secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_err(|_| "io_error")?
		.as_secs();
	let pid = libc::pid_t::try_from(std::process::id()).map_err(|_| "io_error")?;
	let process = linux_process_identity(pid);
	if family == ".gjc-managed-replace" && process.is_none() {
		// Never publish an in-flight candidate without observable namespace and
		// generation identity; PID interpretation is namespace-relative.
		return Err("io_error");
	}
	if let Some(publisher) = process {
		return Ok(format!(
			"{family}-{pid}-{}-{:032x}-{}-{counter}-{created_at_secs}",
			publisher.pid_namespace,
			u128::from_be_bytes(publisher.boot_id),
			publisher.start_time_ticks,
		));
	}
	// Completion/removal names do not need live-publisher identity, so retain their
	// timestamped format when procfs is unavailable.
	Ok(format!("{family}-{pid}-{counter}-{created_at_secs}"))
}

#[cfg(target_os = "linux")]
fn parse_canonical_u64(bytes: &[u8]) -> Option<u64> {
	if bytes.is_empty() || !bytes.iter().all(u8::is_ascii_digit) {
		return None;
	}
	if bytes.len() > 1 && bytes[0] == b'0' {
		return None;
	}
	std::str::from_utf8(bytes).ok()?.parse::<u64>().ok()
}

#[cfg(target_os = "linux")]
fn parse_boot_id_hex(bytes: &[u8]) -> Option<[u8; 16]> {
	if bytes.len() != 32
		|| !bytes
			.iter()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
	{
		return None;
	}
	let hex = std::str::from_utf8(bytes).ok()?;
	let boot_id = u128::from_str_radix(hex, 16).ok()?.to_be_bytes();
	(boot_id != [0; 16]).then_some(boot_id)
}

#[cfg(target_os = "linux")]
fn parse_linux_boot_id(value: &str) -> Option<[u8; 16]> {
	let bytes = value.trim().as_bytes();
	if bytes.len() != 36
		|| bytes[8] != b'-'
		|| bytes[13] != b'-'
		|| bytes[18] != b'-'
		|| bytes[23] != b'-'
	{
		return None;
	}
	let compact = bytes
		.iter()
		.copied()
		.filter(|byte| *byte != b'-')
		.collect::<Vec<_>>();
	parse_boot_id_hex(&compact)
}

#[cfg(target_os = "linux")]
fn linux_boot_info() -> Option<LinuxBootInfo> {
	static BOOT_INFO: OnceLock<LinuxBootInfo> = OnceLock::new();
	if let Some(boot_info) = BOOT_INFO.get() {
		return Some(*boot_info);
	}
	let boot_id =
		parse_linux_boot_id(&std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?)?;
	let _ = BOOT_INFO.set(LinuxBootInfo { boot_id });
	BOOT_INFO.get().copied()
}

#[cfg(target_os = "linux")]
fn parse_linux_process_start_ticks(stat: &[u8]) -> Option<u64> {
	let command_end = stat
		.windows(2)
		.rposition(|window| window == b") ")?
		.checked_add(2)?;
	let start_time = stat
		.get(command_end..)?
		.split(|byte| byte.is_ascii_whitespace())
		.filter(|field| !field.is_empty())
		.nth(19)?;
	parse_canonical_u64(start_time)
}

#[cfg(target_os = "linux")]
fn linux_process_identity(pid: libc::pid_t) -> Option<ManagedPublisherIdentity> {
	if pid <= 0 {
		return None;
	}
	// `/proc/self` binds observation to this task even if the procfs mount uses
	// a PID view that does not interpret its namespace-local numeric PID.
	// SAFETY: getpid has no preconditions and only reads the current PID.
	let is_current_process = pid == unsafe { libc::getpid() };
	let boot = linux_boot_info()?;
	let pid_namespace = if is_current_process {
		linux_current_pid_namespace_identity()?
	} else {
		linux_pid_namespace_identity(pid)?
	};
	let stat_path = if is_current_process {
		"/proc/self/stat".to_owned()
	} else {
		format!("/proc/{pid}/stat")
	};
	let stat = std::fs::read(stat_path).ok()?;
	let start_time_ticks = parse_linux_process_start_ticks(&stat)?;
	Some(ManagedPublisherIdentity { pid_namespace, boot_id: boot.boot_id, start_time_ticks })
}

#[cfg(target_os = "linux")]
fn linux_pid_namespace_identity(pid: libc::pid_t) -> Option<u64> {
	if pid <= 0 {
		return None;
	}
	std::fs::metadata(format!("/proc/{pid}/ns/pid"))
		.ok()
		.map(|metadata| metadata.ino())
		.filter(|inode| *inode != 0)
}

#[cfg(target_os = "linux")]
fn linux_current_pid_namespace_identity() -> Option<u64> {
	std::fs::metadata("/proc/self/ns/pid")
		.ok()
		.map(|metadata| metadata.ino())
		.filter(|inode| *inode != 0)
}

#[cfg(target_os = "linux")]
fn process_generation_is_definitely_different(
	publisher: Option<ManagedPublisherIdentity>,
	current: ManagedPublisherIdentity,
) -> bool {
	match publisher {
		Some(publisher) if publisher.pid_namespace == current.pid_namespace => {
			publisher.boot_id != current.boot_id
				|| publisher.start_time_ticks != current.start_time_ticks
		},
		Some(_) => false,
		// Old names lack namespace-bound generation identity. Their timestamp is
		// wall-clock based, so it cannot safely prove PID reuse after clock changes.
		None => false,
	}
}

#[cfg(target_os = "linux")]
fn parse_managed_recovery_name(name: &[u8]) -> Option<ManagedRecoveryName> {
	let (kind, remainder) =
		if let Some(remainder) = name.strip_prefix(b".gjc-managed-replace-complete-") {
			(ManagedRecoveryKind::CompletedReplace, remainder)
		} else if let Some(remainder) = name.strip_prefix(b".gjc-managed-replace-") {
			(ManagedRecoveryKind::Replace, remainder)
		} else {
			(ManagedRecoveryKind::Remove, name.strip_prefix(b".gjc-managed-remove-")?)
		};
	let mut fields = remainder.split(|byte| *byte == b'-');
	let pid = parse_canonical_u64(fields.next()?)?;
	let next = fields.next()?;
	let tagged = |field: &[u8]| field.len() == 32 && field.iter().all(u8::is_ascii_hexdigit);
	let (publisher, created_at_secs) = if tagged(next) {
		// Prior tagged names lack PID-namespace identity. Validate their complete
		// shape, but treat the publisher namespace as unobservable.
		let _boot_id = parse_boot_id_hex(next)?;
		let _start_time_ticks = parse_canonical_u64(fields.next()?)?;
		let _counter = parse_canonical_u64(fields.next()?)?;
		let created_at_secs = parse_canonical_u64(fields.next()?)?;
		(None, Some(created_at_secs))
	} else {
		let first_number = parse_canonical_u64(next)?;
		let following = fields.next();
		if following.is_some_and(tagged) {
			let pid_namespace = first_number;
			if pid_namespace == 0 {
				return None;
			}
			let boot_id = parse_boot_id_hex(following?)?;
			let start_time_ticks = parse_canonical_u64(fields.next()?)?;
			let _counter = parse_canonical_u64(fields.next()?)?;
			let created_at_secs = parse_canonical_u64(fields.next()?)?;
			(
				Some(ManagedPublisherIdentity { pid_namespace, boot_id, start_time_ticks }),
				Some(created_at_secs),
			)
		} else {
			let created_at_secs = match following {
				Some(timestamp) => Some(parse_canonical_u64(timestamp)?),
				None => None,
			};
			(None, created_at_secs)
		}
	};
	if fields.next().is_some() || created_at_secs == Some(0) {
		return None;
	}
	let pid = libc::pid_t::try_from(pid).ok()?;
	(pid > 0).then_some(ManagedRecoveryName { pid, publisher, kind, created_at_secs })
}

#[cfg(target_os = "linux")]
fn process_is_definitely_dead_for_candidate(candidate: ManagedRecoveryName) -> bool {
	process_is_definitely_dead_for_candidate_with_observations(
		candidate,
		linux_current_pid_namespace_identity(),
		linux_process_identity,
		process_is_definitely_dead,
	)
}

#[cfg(target_os = "linux")]
fn process_is_definitely_dead_for_candidate_with_observations(
	candidate: ManagedRecoveryName,
	reaper_pid_namespace: Option<u64>,
	mut observe_process: impl FnMut(libc::pid_t) -> Option<ManagedPublisherIdentity>,
	mut process_is_dead: impl FnMut(libc::pid_t) -> bool,
) -> bool {
	let Some(publisher) = candidate.publisher else {
		// Old tagged and untagged names do not prove which PID namespace their
		// numeric PID belonged to, so neither procfs nor kill(0) can prove death.
		return false;
	};
	if reaper_pid_namespace != Some(publisher.pid_namespace) {
		return false;
	}
	if let Some(current) = observe_process(candidate.pid) {
		return current.pid_namespace == publisher.pid_namespace
			&& process_generation_is_definitely_different(Some(publisher), current);
	}
	// ESRCH is meaningful only after proving the stored PID namespace is the
	// reaper's namespace; otherwise the same number can identify another process.
	process_is_dead(candidate.pid)
}

#[cfg(target_os = "linux")]
fn process_is_definitely_dead(pid: libc::pid_t) -> bool {
	if pid <= 0 {
		return false;
	}
	// SAFETY: kill(pid, 0) only probes process existence and does not send a
	// signal.
	if unsafe { libc::kill(pid, 0) } == 0 {
		return false;
	}
	std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(target_os = "linux")]
fn reaper_directory_identity(recovery: &File) -> Result<(u64, u64), &'static str> {
	let identity = identity(recovery)?;
	let device = identity
		.dev
		.parse::<u64>()
		.map_err(|_| "identity_mismatch")?;
	let inode = identity
		.ino
		.parse::<u64>()
		.map_err(|_| "identity_mismatch")?;
	Ok((device, inode))
}

#[cfg(target_os = "linux")]
fn reaper_cursor_name_matches(
	recovery: &File,
	name: &CString,
	file: &File,
) -> Result<(), &'static str> {
	crate::path_identity::platform::verify_created_owner_only_file(file)?;
	let identity = regular_identity(file)?;
	let named = statat(recovery, name)?;
	if !reaper_owner_file_stat(&named) || !stat_matches_regular_identity(&named, &identity) {
		return Err("identity_mismatch");
	}
	Ok(())
}

#[cfg(target_os = "linux")]
fn reaper_cursor_contents(directory_identity: (u64, u64), cookie: libc::c_long) -> String {
	let payload = format!("{}-{}-{cookie}", directory_identity.0, directory_identity.1);
	let checksum = hex_digest(Sha256::digest(payload.as_bytes()).into());
	format!("{payload}-{checksum}\n")
}

#[cfg(target_os = "linux")]
fn parse_reaper_cursor(value: &[u8], directory_identity: (u64, u64)) -> Option<libc::c_long> {
	let line = value.strip_suffix(b"\n")?;
	let checksum_separator = line.iter().rposition(|byte| *byte == b'-')?;
	let (payload, checksum) = line.split_at(checksum_separator);
	let checksum = checksum.strip_prefix(b"-")?;
	let expected_checksum = hex_digest(Sha256::digest(payload).into());
	if checksum != expected_checksum.as_bytes() {
		return None;
	}
	let mut fields = payload.split(|byte| *byte == b'-');
	let device = parse_canonical_u64(fields.next()?)?;
	let inode = parse_canonical_u64(fields.next()?)?;
	let cookie = parse_canonical_u64(fields.next()?)?;
	if fields.next().is_some() || (device, inode) != directory_identity {
		return None;
	}
	libc::c_long::try_from(cookie).ok()
}

#[cfg(target_os = "linux")]
struct RecoveryReaperCursor {
	name:               CString,
	file:               File,
	cookie:             libc::c_long,
	directory_identity: (u64, u64),
}

#[cfg(target_os = "linux")]
fn open_reaper_cursor(recovery: &File) -> Result<RecoveryReaperCursor, &'static str> {
	let name = CString::new(RECOVERY_REAPER_CURSOR_NAME).map_err(|_| "io_error")?;
	// Claim the fixed state entry without following or replacing an existing name.
	// If another reaper won creation, open that entry separately and validate it.
	// SAFETY: recovery is a retained directory descriptor and name is a live,
	// NUL-terminated child component for this call.
	let created = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDWR
				| libc::O_CREAT
				| libc::O_EXCL
				| libc::O_CLOEXEC
				| libc::O_NOFOLLOW
				| libc::O_NONBLOCK,
			0o600,
		)
	};
	let (fd, newly_created) = if created >= 0 {
		(created, true)
	} else if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
		// SAFETY: recovery is a retained directory descriptor and name remains a
		// live, NUL-terminated child component for this call.
		let fd = unsafe {
			libc::openat(
				recovery.as_raw_fd(),
				name.as_ptr(),
				libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if fd < 0 {
			return Err("io_error");
		}
		(fd, false)
	} else {
		return Err("io_error");
	};
	// SAFETY: openat returned a uniquely owned descriptor.
	let mut file = unsafe { File::from_raw_fd(fd) };
	if newly_created {
		crate::path_identity::platform::secure_created_owner_only_file(&file)?;
	} else {
		crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	}
	loop {
		// Nonblocking flock keeps a bounded maintenance pass from waiting on a
		// different reaper that is holding the persistent cursor.
		// SAFETY: file owns a live descriptor; flock only coordinates reaper
		// instances and releases automatically when the last descriptor closes.
		if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
			break;
		}
		let errno = std::io::Error::last_os_error().raw_os_error();
		if errno == Some(libc::EWOULDBLOCK) || errno == Some(libc::EAGAIN) {
			return Err("cursor_locked");
		}
		if errno != Some(libc::EINTR) {
			return Err("io_error");
		}
	}
	reaper_cursor_name_matches(recovery, &name, &file)?;
	if newly_created {
		file.sync_all().map_err(|_| "fsync_failed")?;
		recovery.sync_all().map_err(|_| "fsync_failed")?;
	}
	let directory_identity = reaper_directory_identity(recovery)?;
	let identity_before_read = regular_identity(&file)?;
	file.seek(SeekFrom::Start(0)).map_err(|_| "io_error")?;
	let mut value = Vec::with_capacity(64);
	let mut limited = (&file).take(129);
	limited.read_to_end(&mut value).map_err(|_| "io_error")?;
	let cursor = if value.len() <= 128 {
		parse_reaper_cursor(&value, directory_identity).unwrap_or(0)
	} else {
		0
	};
	if regular_identity(&file)? != identity_before_read {
		return Err("identity_mismatch");
	}
	reaper_cursor_name_matches(recovery, &name, &file)?;
	Ok(RecoveryReaperCursor { name, file, cookie: cursor, directory_identity })
}

#[cfg(target_os = "linux")]
fn write_reaper_cursor(
	recovery: &File,
	name: &CString,
	file: &mut File,
	directory_identity: (u64, u64),
	cookie: libc::c_long,
) -> Result<(), &'static str> {
	if reaper_directory_identity(recovery)? != directory_identity || cookie < 0 {
		return Err("identity_mismatch");
	}
	reaper_cursor_name_matches(recovery, name, file)?;
	let contents = reaper_cursor_contents(directory_identity, cookie);
	file.seek(SeekFrom::Start(0)).map_err(|_| "io_error")?;
	file.set_len(0).map_err(|_| "io_error")?;
	file
		.write_all(contents.as_bytes())
		.map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	reaper_cursor_name_matches(recovery, name, file)?;
	recovery.sync_all().map_err(|_| "fsync_failed")?;
	Ok(())
}

#[cfg(target_os = "linux")]
fn reap_managed_recovery_if_due(
	recovery: &File,
	state: &Arc<Mutex<RecoveryReaperState>>,
) -> RecoveryReaperMetrics {
	reap_managed_recovery(recovery, state, false)
}

#[cfg(target_os = "linux")]
fn reap_managed_recovery(
	recovery: &File,
	state: &Arc<Mutex<RecoveryReaperState>>,
	force: bool,
) -> RecoveryReaperMetrics {
	reap_managed_recovery_with_limits(
		recovery,
		state,
		force,
		RECOVERY_REAPER_MAX_SCAN_ENTRIES,
		RECOVERY_REAPER_MAX_BYTES,
		process_is_definitely_dead_for_candidate,
	)
}

#[cfg(target_os = "linux")]
fn reap_managed_recovery_with_limits(
	recovery: &File,
	state: &Arc<Mutex<RecoveryReaperState>>,
	force: bool,
	max_scan_entries: usize,
	max_bytes: u64,
	process_is_dead: impl FnMut(ManagedRecoveryName) -> bool,
) -> RecoveryReaperMetrics {
	let mut state = state.lock();
	let now = Instant::now();
	if !force
		&& state.last_attempt.is_some_and(|last_attempt| {
			now.duration_since(last_attempt) < RECOVERY_REAPER_SWEEP_INTERVAL
		}) {
		return state.last_metrics;
	}
	state.last_attempt = Some(now);
	let Ok(unix_now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
		return record_reaper_metrics(&mut state, RecoveryReaperMetrics {
			failures: 1,
			..RecoveryReaperMetrics::default()
		});
	};
	let cursor = open_reaper_cursor(recovery);
	let (mut directory_cookie, mut cursor_state, cursor_open_failed) = match cursor {
		Ok(cursor) => {
			let RecoveryReaperCursor { name, file, cookie, directory_identity } = cursor;
			(cookie, Some((name, file, directory_identity)), false)
		},
		Err("cursor_locked") => {
			return record_reaper_metrics(&mut state, RecoveryReaperMetrics {
				scan_limited: true,
				..RecoveryReaperMetrics::default()
			});
		},
		Err(_) => (0, None, true),
	};
	let mut metrics = reap_managed_recovery_at_with_cursor(
		recovery,
		unix_now.as_secs(),
		&mut directory_cookie,
		max_scan_entries,
		max_bytes,
		|cookie| match cursor_state.as_mut() {
			Some((name, file, directory_identity)) => {
				write_reaper_cursor(recovery, name, file, *directory_identity, cookie)
			},
			None => Ok(()),
		},
		process_is_dead,
	);
	if cursor_open_failed {
		metrics.failures = metrics.failures.saturating_add(1);
		metrics.scan_limited = true;
	}
	record_reaper_metrics(&mut state, metrics)
}

#[cfg(target_os = "linux")]
const fn record_reaper_metrics(
	state: &mut RecoveryReaperState,
	mut metrics: RecoveryReaperMetrics,
) -> RecoveryReaperMetrics {
	state.totals.reaped_files = state
		.totals
		.reaped_files
		.saturating_add(metrics.reaped_files);
	state.totals.reaped_bytes = state
		.totals
		.reaped_bytes
		.saturating_add(metrics.reaped_bytes);
	state.totals.failures = state.totals.failures.saturating_add(metrics.failures);
	metrics.total_reaped_files = state.totals.reaped_files;
	metrics.total_reaped_bytes = state.totals.reaped_bytes;
	metrics.total_failures = state.totals.failures;
	state.last_metrics = metrics;
	metrics
}

#[cfg(target_os = "linux")]
fn reaper_owner_file_stat(stat: &libc::stat) -> bool {
	// SAFETY: geteuid has no preconditions and only reads the effective user ID.
	let effective_uid = unsafe { libc::geteuid() };
	(stat.st_mode & libc::S_IFMT) == libc::S_IFREG
		&& stat.st_uid == effective_uid
		&& stat.st_mode & 0o7777 == 0o600
		&& stat.st_nlink == 1
		&& stat.st_size >= 0
}

#[cfg(target_os = "linux")]
const fn managed_recovery_family(kind: ManagedRecoveryKind) -> &'static str {
	match kind {
		ManagedRecoveryKind::Replace => ".gjc-managed-replace",
		ManagedRecoveryKind::CompletedReplace => ".gjc-managed-replace-complete",
		ManagedRecoveryKind::Remove => ".gjc-managed-remove",
	}
}

#[cfg(target_os = "linux")]
fn reaper_legacy_marker_name(
	name: &CString,
	identity: &RecoveryFsIdentity,
) -> Result<CString, &'static str> {
	let key = format!(
		"{}:{}:{}:{}:{}:{}",
		identity.dev,
		identity.ino,
		identity.size,
		identity.mtime_ns,
		identity.ctime_ns,
		identity.nlink,
	);
	let mut digest = Sha256::new();
	digest.update(name.as_bytes());
	digest.update(key.as_bytes());
	CString::new(format!(".gjc-reaper-first-seen-{}", hex_digest(digest.finalize().into())))
		.map_err(|_| "io_error")
}

#[cfg(target_os = "linux")]
fn read_reaper_marker(
	recovery: &File,
	marker_name: &CString,
) -> Result<Option<(u64, RecoveryReaperMarker)>, &'static str> {
	// SAFETY: the retained parent fd and validated marker name constrain this open
	// to one child entry without following links.
	let fd = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			marker_name.as_ptr(),
			libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::ENOENT) => Ok(None),
			_ => Err("io_error"),
		};
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	let mut file = unsafe { File::from_raw_fd(fd) };
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	let identity = regular_identity(&file)?;
	let named = statat(recovery, marker_name)?;
	if !reaper_owner_file_stat(&named) || !stat_matches_regular_identity(&named, &identity) {
		return Err("identity_mismatch");
	}
	let size = identity
		.size
		.parse::<u64>()
		.map_err(|_| "identity_mismatch")?;
	if size > 32 {
		return Err("identity_mismatch");
	}
	let mut value = Vec::with_capacity(size as usize);
	let mut limited = std::io::Read::by_ref(&mut file).take(33);
	limited.read_to_end(&mut value).map_err(|_| "io_error")?;
	if value.len() > 32 {
		return Err("identity_mismatch");
	}
	if regular_identity(&file)? != identity
		|| crate::path_identity::platform::verify_created_owner_only_file(&file).is_err()
	{
		return Err("identity_mismatch");
	}
	drop(file);
	let Some(timestamp) = value.strip_suffix(b"\n").and_then(parse_canonical_u64) else {
		return Err("identity_mismatch");
	};
	Ok(Some((timestamp, RecoveryReaperMarker { name: marker_name.clone(), identity })))
}

#[cfg(target_os = "linux")]
fn first_seen_for_legacy_candidate(
	recovery: &File,
	name: &CString,
	identity: &RecoveryFsIdentity,
	now_secs: u64,
) -> Result<(u64, RecoveryReaperMarker), &'static str> {
	let marker_name = reaper_legacy_marker_name(name, identity)?;
	match read_reaper_marker(recovery, &marker_name) {
		Ok(Some(marker)) => return Ok(marker),
		Ok(None) => {},
		Err("identity_mismatch") => {
			return reset_reaper_marker(recovery, &marker_name, now_secs);
		},
		Err(error) => return Err(error),
	}
	let contents = format!("{now_secs}\n");
	// SAFETY: the retained recovery fd and generated marker name are live. EXCL
	// guarantees that a concurrently-created marker is never overwritten.
	let fd = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			marker_name.as_ptr(),
			libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			0o600,
		)
	};
	if fd < 0 {
		if std::io::Error::last_os_error().raw_os_error() == Some(libc::EEXIST) {
			return read_reaper_marker(recovery, &marker_name)?.ok_or("identity_mismatch");
		}
		return Err("io_error");
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	let mut file = unsafe { File::from_raw_fd(fd) };
	crate::path_identity::platform::secure_created_owner_only_file(&file)?;
	file
		.write_all(contents.as_bytes())
		.map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	let marker_identity = regular_identity(&file)?;
	let marker_stat = statat(recovery, &marker_name)?;
	if !reaper_owner_file_stat(&marker_stat)
		|| !stat_matches_regular_identity(&marker_stat, &marker_identity)
	{
		return Err("identity_mismatch");
	}
	recovery.sync_all().map_err(|_| "fsync_failed")?;
	drop(file);
	Ok((now_secs, RecoveryReaperMarker { name: marker_name, identity: marker_identity }))
}

#[cfg(target_os = "linux")]
fn reset_reaper_marker(
	recovery: &File,
	marker_name: &CString,
	now_secs: u64,
) -> Result<(u64, RecoveryReaperMarker), &'static str> {
	// A crash during first-seen publication may leave an empty/partial owner-only
	// marker. Reset only that exact single-linked regular marker and start a fresh
	// retention interval; untrusted marker types or permissions still fail closed.
	// SAFETY: the retained parent fd and generated marker name constrain this open
	// to one child entry without following links.
	let fd = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			marker_name.as_ptr(),
			libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return Err("io_error");
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	let mut file = unsafe { File::from_raw_fd(fd) };
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	let before = regular_identity(&file)?;
	let named = statat(recovery, marker_name)?;
	if !reaper_owner_file_stat(&named) || !stat_matches_regular_identity(&named, &before) {
		return Err("identity_mismatch");
	}
	if before
		.size
		.parse::<u64>()
		.map_err(|_| "identity_mismatch")?
		> 32
	{
		return Err("identity_mismatch");
	}
	file.set_len(0).map_err(|_| "io_error")?;
	file
		.write_all(format!("{now_secs}\n").as_bytes())
		.map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	let marker_identity = regular_identity(&file)?;
	let named = statat(recovery, marker_name)?;
	if !reaper_owner_file_stat(&named) || !stat_matches_regular_identity(&named, &marker_identity) {
		return Err("identity_mismatch");
	}
	recovery.sync_all().map_err(|_| "fsync_failed")?;
	drop(file);
	Ok((now_secs, RecoveryReaperMarker { name: marker_name.clone(), identity: marker_identity }))
}

#[cfg(target_os = "linux")]
fn remove_reaper_marker(
	recovery: &File,
	marker: &RecoveryReaperMarker,
) -> Result<(), &'static str> {
	let named = statat(recovery, &marker.name)?;
	if !reaper_owner_file_stat(&named) || !stat_matches_regular_identity(&named, &marker.identity) {
		return Err("identity_mismatch");
	}
	// SAFETY: the private marker entry was identity-checked in the retained
	// recovery directory immediately before unlink.
	if unsafe { libc::unlinkat(recovery.as_raw_fd(), marker.name.as_ptr(), 0) } != 0 {
		return Err("io_error");
	}
	Ok(())
}

#[cfg(target_os = "linux")]
enum ReaperCandidateResult {
	Deleted(u64),
	BudgetLimited,
	Preserved,
	Failed,
}

#[cfg(target_os = "linux")]
fn reap_managed_recovery_candidate(
	recovery: &File,
	name: &CString,
	candidate: ManagedRecoveryName,
	now_secs: u64,
	remaining_bytes: u64,
	process_is_dead: &mut impl FnMut(ManagedRecoveryName) -> bool,
) -> ReaperCandidateResult {
	// Replacement staging may still be in-flight, so retain it while its
	// publisher is alive. Successful replacements are atomically moved to the
	// completed family before returning; completed predecessors and detached
	// removals expire after their TTL even if their publisher remains alive.
	if candidate.kind == ManagedRecoveryKind::Replace && !process_is_dead(candidate) {
		return ReaperCandidateResult::Preserved;
	}
	let Ok(named_before) = statat(recovery, name) else {
		return ReaperCandidateResult::Preserved;
	};
	if !reaper_owner_file_stat(&named_before) {
		return ReaperCandidateResult::Preserved;
	}
	// SAFETY: the retained recovery descriptor and dirent-derived NUL-terminated
	// name are live. O_NOFOLLOW rejects links and O_NONBLOCK prevents a raced FIFO
	// from blocking this bounded maintenance pass.
	let fd = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			name.as_ptr(),
			libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if fd < 0 {
		return ReaperCandidateResult::Preserved;
	}
	// SAFETY: successful openat returned a uniquely owned descriptor.
	let file = unsafe { File::from_raw_fd(fd) };
	let Ok(opened_identity) = regular_identity(&file) else {
		return ReaperCandidateResult::Preserved;
	};
	if crate::path_identity::platform::verify_created_owner_only_file(&file).is_err()
		|| !stat_matches_regular_identity(&named_before, &opened_identity)
		|| !reaper_owner_file_stat(&named_before)
	{
		return ReaperCandidateResult::Preserved;
	}
	let size = match opened_identity.size.parse::<u64>() {
		Ok(size) if size <= remaining_bytes => size,
		Ok(_) => return ReaperCandidateResult::BudgetLimited,
		Err(_) => return ReaperCandidateResult::Preserved,
	};
	let (first_seen_secs, legacy_marker) = match candidate.created_at_secs {
		Some(created_at_secs) => (created_at_secs, None),
		None => match first_seen_for_legacy_candidate(recovery, name, &opened_identity, now_secs) {
			Ok((first_seen_secs, marker)) => (first_seen_secs, Some(marker)),
			Err(_) => return ReaperCandidateResult::Failed,
		},
	};
	let retention_secs = match candidate.kind {
		ManagedRecoveryKind::Replace | ManagedRecoveryKind::CompletedReplace => {
			RECOVERY_REAPER_REPLACE_GRACE_SECS
		},
		ManagedRecoveryKind::Remove => RECOVERY_REAPER_REMOVE_TTL_SECS,
	};
	let minimum_age = retention_secs.saturating_add(RECOVERY_REAPER_CLOCK_GRACE_SECS);
	if now_secs
		.checked_sub(first_seen_secs)
		.is_none_or(|age| age < minimum_age)
	{
		return ReaperCandidateResult::Preserved;
	}
	let final_identity = match regular_identity(&file) {
		Ok(identity) if identity == opened_identity => identity,
		_ => return ReaperCandidateResult::Preserved,
	};
	if crate::path_identity::platform::verify_created_owner_only_file(&file).is_err() {
		return ReaperCandidateResult::Preserved;
	}
	drop(file);
	// NFS silly-renames an unlinked file while it is still open. Drop the checked
	// descriptor before unlinking, then recheck the descriptor-relative name as
	// close to unlinkat as possible.
	let Ok(named_before_quarantine) = statat(recovery, name) else {
		return ReaperCandidateResult::Preserved;
	};
	if !stat_matches_regular_identity(&named_before_quarantine, &final_identity)
		|| !reaper_owner_file_stat(&named_before_quarantine)
	{
		return ReaperCandidateResult::Preserved;
	}
	if let Some(marker) = legacy_marker
		&& (remove_reaper_marker(recovery, &marker).is_err() || recovery.sync_all().is_err())
	{
		return ReaperCandidateResult::Failed;
	}
	// First move the verified entry to a fresh exact managed-family name. This
	// turns an unexpected name replacement between the scan and unlink into a
	// detectable identity mismatch rather than deleting the replacement object.
	let mut quarantine = None;
	for _ in 0..16 {
		let Ok(quarantine_name) = managed_recovery_name(
			managed_recovery_family(candidate.kind),
			MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed) | (1_u64 << 63),
		) else {
			return ReaperCandidateResult::Failed;
		};
		let Ok(quarantine_name) = CString::new(quarantine_name) else {
			return ReaperCandidateResult::Failed;
		};
		match rename_reaper_quarantine_no_replace(recovery, name, &quarantine_name, &final_identity) {
			Ok(_) => {
				quarantine = Some(quarantine_name);
				break;
			},
			Err(error) if error.raw_os_error() == Some(libc::EEXIST) && !error.committed() => {},
			Err(_) => return ReaperCandidateResult::Failed,
		}
	}
	let Some(quarantine) = quarantine else {
		return ReaperCandidateResult::Failed;
	};
	if recovery.sync_all().is_err() {
		return ReaperCandidateResult::Failed;
	}
	let Ok(moved_stat) = statat(recovery, &quarantine) else {
		return ReaperCandidateResult::Failed;
	};
	if !stat_matches_regular_identity_after_rename(&moved_stat, &final_identity)
		|| !reaper_owner_file_stat(&moved_stat)
	{
		// Restore an unexpected object when the original name remains free; if it
		// does not, preserve it under the fresh managed-family quarantine name.
		let _ = rename_file_no_replace(recovery, &quarantine, recovery, name, || {});
		return ReaperCandidateResult::Preserved;
	}
	let Ok(final_named_stat) = statat(recovery, &quarantine) else {
		return ReaperCandidateResult::Failed;
	};
	if !stat_matches_regular_identity_after_rename(&final_named_stat, &final_identity)
		|| !reaper_owner_file_stat(&final_named_stat)
	{
		return ReaperCandidateResult::Preserved;
	}
	// SAFETY: this is the identity-rechecked, descriptor-relative quarantine name
	// created above, not the original potentially raced pathname.
	if unsafe { libc::unlinkat(recovery.as_raw_fd(), quarantine.as_ptr(), 0) } != 0 {
		return ReaperCandidateResult::Failed;
	}
	ReaperCandidateResult::Deleted(size)
}

#[cfg(all(test, target_os = "linux"))]
fn reap_managed_recovery_at(
	recovery: &File,
	now_secs: u64,
	directory_cookie: &mut libc::c_long,
	process_is_dead: impl FnMut(ManagedRecoveryName) -> bool,
) -> RecoveryReaperMetrics {
	reap_managed_recovery_at_with_cursor(
		recovery,
		now_secs,
		directory_cookie,
		RECOVERY_REAPER_MAX_SCAN_ENTRIES,
		RECOVERY_REAPER_MAX_BYTES,
		|_| Ok(()),
		process_is_dead,
	)
}

#[cfg(target_os = "linux")]
fn reap_managed_recovery_at_with_cursor(
	recovery: &File,
	now_secs: u64,
	directory_cookie: &mut libc::c_long,
	max_scan_entries: usize,
	max_bytes: u64,
	mut persist_cookie: impl FnMut(libc::c_long) -> Result<(), &'static str>,
	mut process_is_dead: impl FnMut(ManagedRecoveryName) -> bool,
) -> RecoveryReaperMetrics {
	let mut metrics = RecoveryReaperMetrics::default();
	// Never rename or recreate this directory: retained descriptors must continue
	// to address one namespace. Compaction is limited to unlinking eligible files.
	// SAFETY: opening "." relative to the retained recovery descriptor produces an
	// independent directory stream and does not change the retained descriptor's
	// file offset.
	let duplicate = unsafe {
		libc::openat(
			recovery.as_raw_fd(),
			c".".as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	if duplicate < 0 {
		metrics.failures = 1;
		return metrics;
	}
	// SAFETY: duplicate is live and ownership transfers to fdopendir on success.
	let directory = unsafe { libc::fdopendir(duplicate) };
	if directory.is_null() {
		// SAFETY: fdopendir failed, so duplicate remains owned and must be closed.
		unsafe { libc::close(duplicate) };
		metrics.failures = 1;
		return metrics;
	}
	// SAFETY: directory is a live DIR stream and the saved cookie came from this
	// directory's previous readdir call.
	unsafe { libc::seekdir(directory, *directory_cookie) };
	let mut candidates = Vec::new();
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
			if errno != 0 {
				metrics.failures = metrics.failures.saturating_add(1);
			}
			*directory_cookie = 0;
			break;
		}
		// SAFETY: readdir returned a live dirent and d_off is the cookie after this
		// entry in the current directory stream.
		let entry = unsafe { &*entry };
		*directory_cookie = entry.d_off as libc::c_long;
		// SAFETY: d_name is NUL-terminated in the live dirent.
		let name = unsafe { std::ffi::CStr::from_ptr(entry.d_name.as_ptr()) }.to_bytes();
		if name == b"." || name == b".." || name == RECOVERY_REAPER_CURSOR_NAME {
			continue;
		}
		metrics.scanned_entries = metrics.scanned_entries.saturating_add(1);
		if let Some(candidate) = parse_managed_recovery_name(name)
			&& let Ok(name) = CString::new(name)
		{
			candidates.push((name, candidate));
		}
		if metrics.scanned_entries >= max_scan_entries as u64 {
			metrics.scan_limited = true;
			break;
		}
	}
	// SAFETY: directory is owned by this function and closed exactly once here.
	if unsafe { libc::closedir(directory) } != 0 {
		metrics.failures = metrics.failures.saturating_add(1);
		*directory_cookie = 0;
		if persist_cookie(0).is_err() {
			metrics.failures = metrics.failures.saturating_add(1);
		}
		return metrics;
	}
	if persist_cookie(*directory_cookie).is_err() {
		metrics.failures = metrics.failures.saturating_add(1);
		metrics.scan_limited = true;
	}
	let mut bytes_left = max_bytes;
	for (name, candidate) in candidates {
		if metrics.reaped_files >= RECOVERY_REAPER_MAX_FILES {
			metrics.scan_limited = true;
			break;
		}
		match reap_managed_recovery_candidate(
			recovery,
			&name,
			candidate,
			now_secs,
			bytes_left,
			&mut process_is_dead,
		) {
			ReaperCandidateResult::Deleted(bytes) => {
				metrics.reaped_files = metrics.reaped_files.saturating_add(1);
				metrics.reaped_bytes = metrics.reaped_bytes.saturating_add(bytes);
				bytes_left = bytes_left.saturating_sub(bytes);
			},
			ReaperCandidateResult::Preserved => {
				metrics.preserved_candidates = metrics.preserved_candidates.saturating_add(1);
			},
			ReaperCandidateResult::BudgetLimited => {
				metrics.preserved_candidates = metrics.preserved_candidates.saturating_add(1);
				metrics.scan_limited = true;
			},
			ReaperCandidateResult::Failed => {
				metrics.failures = metrics.failures.saturating_add(1);
			},
		}
	}
	if metrics.reaped_files > 0 && recovery.sync_all().is_err() {
		metrics.failures = metrics.failures.saturating_add(1);
	}
	metrics
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
	let recovery_parent = recovery_directory(root, recovery)?;
	let quarantine = CString::new(managed_recovery_name(
		".gjc-managed-remove",
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed),
	)?)
	.map_err(|_| "io_error")?;
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
	let expected_size_value = expected_size
		.parse::<u64>()
		.map_err(|_| "identity_mismatch")?;
	let Some(appended_size) = expected_size_value.checked_add(data.len() as u64) else {
		return Err("content_too_large");
	};
	if appended_size > MAX_MANAGED_CONTENT_BYTES {
		return Err("content_too_large");
	}
	let (parent, name) = open_parent(root, relative_path)?;
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
		return Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::ENOENT) => "not_found",
			_ => "io_error",
		});
	}
	// SAFETY: successful openat returned a uniquely owned fd.
	let mut file = unsafe { File::from_raw_fd(fd) };
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	if !same_expected(
		&file,
		expected_dev,
		expected_ino,
		expected_size,
		expected_mtime_ns,
		expected_ctime_ns,
		expected_sha256,
	)? {
		return Err("identity_mismatch");
	}
	file.write_all(data).map_err(|_| "io_error")?;
	file.sync_all().map_err(|_| "fsync_failed")?;
	crate::path_identity::platform::verify_created_owner_only_file(&file)?;
	let mut identity = regular_identity(&file)?;
	if identity.dev != expected_dev
		|| identity.ino != expected_ino
		|| identity.size != appended_size.to_string()
	{
		return Err("identity_mismatch");
	}
	let named = statat(&parent, &name)?;
	if !stat_matches_regular_identity(&named, &identity) {
		return Err("identity_mismatch");
	}
	identity.sha256 = Some(digest_hex(&file)?);
	parent.sync_all().map_err(|_| "fsync_failed")?;
	Ok(RecoveryFsResult::success(identity))
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
) -> Result<RecoveryFsResult, &'static str> {
	let recovery_parent = recovery_directory(root, recovery)?;
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
	let candidate = (0..16)
		.find_map(|_| {
			let name = managed_recovery_name(
				".gjc-managed-replace",
				MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed),
			)
			.ok()?;
			match create(&recovery_parent, &name, data, MAX_MANAGED_CONTENT_BYTES) {
				Ok(_) => Some(Ok(name)),
				Err("already_exists") => None,
				Err(error) => Some(Err(error)),
			}
		})
		.transpose()?
		.ok_or("io_error")?;
	let staging_file = open_existing(&recovery_parent, &candidate, false)?;
	let staging_identity = regular_identity(&staging_file)?;
	crate::path_identity::platform::verify_created_owner_only_file(&staging_file)?;
	let candidate_digest = hex_digest(Sha256::digest(data).into());
	if digest_hex(&staging_file)? != candidate_digest {
		return Err("identity_mismatch");
	}
	let staging_candidate = candidate;
	// Refresh the name timestamp after the candidate is fully written. The final
	// name becomes displaced recovery evidence immediately after this no-replace
	// rename, so its age never includes candidate-write time.
	let candidate = managed_recovery_name(
		".gjc-managed-replace",
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed),
	)?;
	let staging_name = CString::new(staging_candidate).map_err(|_| "io_error")?;
	let candidate_name = CString::new(candidate.clone()).map_err(|_| "io_error")?;
	rename_replacement_candidate_no_replace(
		&recovery_parent,
		&staging_name,
		&recovery_parent,
		&candidate_name,
		move || drop(staging_file),
	)?;
	let candidate_file = open_existing(&recovery_parent, &candidate, false)?;
	let candidate_identity = regular_identity(&candidate_file)?;
	if !same_expected_after_rename(
		&candidate_file,
		&staging_identity.dev,
		&staging_identity.ino,
		&staging_identity.size,
		&staging_identity.mtime_ns,
		&candidate_digest,
	)? {
		return Err("identity_mismatch");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&candidate_file)?;
	let candidate_parent = recovery_parent;
	let (destination_parent, destination_name) = open_parent(root, relative_path)?;
	// The descriptor proving the destination's identity is held across the
	// exchange, matching the authority `renameat2` would have carried. On the
	// link fallback it is released between the rollback link and the rename that
	// displaces the destination: NFS silly-renames a still-open name that a
	// rename displaces, which would leave the displaced object double-linked and
	// fail the `st_nlink == 1` proof re-run against it below. Releasing there
	// costs no provability, because the object is already reachable through the
	// fallback's temporary name, and the checks below re-prove it from the
	// candidate name against the identity verified before publication.
	exchange_managed_replacement(
		&candidate_parent,
		&candidate_name,
		&destination_parent,
		&destination_name,
		move || {
			drop(authorized);
		},
	)?;
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
				|| digest_hex(&candidate_file)? != candidate_digest
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
		return Err("rollback_unavailable");
	};
	if candidate_parent.sync_all().is_err() || destination_parent.sync_all().is_err() {
		return Err("rollback_unavailable");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&candidate_file)?;
	crate::path_identity::platform::verify_created_owner_only_file(&displaced)?;
	crate::path_identity::platform::verify_created_owner_only_file(&replacement)?;
	let terminal_replacement_identity = regular_identity(&replacement)?;
	let terminal_displaced_identity = regular_identity(&displaced)?;
	let terminal_replacement =
		statat(&destination_parent, &destination_name).map_err(|_| "identity_mismatch")?;
	let terminal_displaced =
		statat(&candidate_parent, &candidate_name).map_err(|_| "identity_mismatch")?;
	if terminal_replacement_identity != replacement_identity
		|| terminal_displaced_identity != displaced_identity
		|| digest_hex(&replacement)? != candidate_digest
		|| digest_hex(&displaced)? != expected_sha256
		|| !stat_matches_regular_identity(&terminal_replacement, &terminal_replacement_identity)
		|| !stat_matches_regular_identity(&terminal_displaced, &terminal_displaced_identity)
	{
		return Err("identity_mismatch");
	}
	// The exchange committed, so publish a terminal family name for the displaced
	// predecessor. Keeping the in-flight name would exempt this completed evidence
	// from TTL cleanup for as long as this publisher process remained alive.
	let completed_candidate = managed_recovery_name(
		".gjc-managed-replace-complete",
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed),
	)?;
	let completed_candidate_name = CString::new(completed_candidate).map_err(|_| "io_error")?;
	if rename_file_no_replace(
		&candidate_parent,
		&candidate_name,
		&candidate_parent,
		&completed_candidate_name,
		move || drop(displaced),
	)
	.is_err()
	{
		return Err("rollback_unavailable");
	}
	candidate_parent
		.sync_all()
		.map_err(|_| "rollback_unavailable")?;
	let terminal_completed =
		statat(&candidate_parent, &completed_candidate_name).map_err(|_| "identity_mismatch")?;
	if !stat_matches_regular_identity_after_rename(&terminal_completed, &displaced_identity)
		|| !reaper_owner_file_stat(&terminal_completed)
	{
		return Err("identity_mismatch");
	}
	// Publication is committed and the displaced object remains recoverable under
	// a terminal name. The reaper retains it for the configured TTL, then removes
	// it only after its descriptor-relative identity checks succeed.
	Ok(RecoveryFsResult::success(replacement_identity))
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
		os::unix::fs::PermissionsExt,
		path::PathBuf,
		time::{SystemTime, UNIX_EPOCH},
	};

	struct TempDir(PathBuf);
	static TEMP_DIR_ID: AtomicU64 = AtomicU64::new(0);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"pi-recovery-fs-fault-test-{}-{}-{}",
				std::process::id(),
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("clock before epoch")
					.as_nanos(),
				TEMP_DIR_ID.fetch_add(1, Ordering::Relaxed),
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

	fn recovery_name(family: &str, pid: u32, counter: u64, created_at_secs: u64) -> String {
		format!("{family}-{pid}-{counter}-{created_at_secs}")
	}

	fn recovery_name_with_publisher(
		family: &str,
		pid: u32,
		publisher: ManagedPublisherIdentity,
		counter: u64,
		created_at_secs: u64,
	) -> String {
		format!(
			"{family}-{pid}-{}-{:032x}-{}-{counter}-{created_at_secs}",
			publisher.pid_namespace,
			u128::from_be_bytes(publisher.boot_id),
			publisher.start_time_ticks,
		)
	}

	fn write_reaper_file(directory: &std::path::Path, name: &str, contents: &[u8], mode: u32) {
		let path = directory.join(name);
		fs::write(&path, contents).expect("write recovery file");
		fs::set_permissions(&path, fs::Permissions::from_mode(mode)).expect("set recovery mode");
	}

	fn unix_now_secs() -> u64 {
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("clock before epoch")
			.as_secs()
	}

	#[test]
	fn managed_recovery_name_parser_accepts_only_canonical_timestamped_families() {
		assert_eq!(
			parse_managed_recovery_name(b".gjc-managed-replace-17-0-42"),
			Some(ManagedRecoveryName {
				pid:             17,
				publisher:       None,
				kind:            ManagedRecoveryKind::Replace,
				created_at_secs: Some(42),
			})
		);
		assert_eq!(
			parse_managed_recovery_name(b".gjc-managed-replace-complete-17-1-42"),
			Some(ManagedRecoveryName {
				pid:             17,
				publisher:       None,
				kind:            ManagedRecoveryKind::CompletedReplace,
				created_at_secs: Some(42),
			})
		);
		assert_eq!(
			parse_managed_recovery_name(b".gjc-managed-remove-18-9-43"),
			Some(ManagedRecoveryName {
				pid:             18,
				publisher:       None,
				kind:            ManagedRecoveryKind::Remove,
				created_at_secs: Some(43),
			})
		);
		assert_eq!(
			parse_managed_recovery_name(b".gjc-managed-remove-18-9"),
			Some(ManagedRecoveryName {
				pid:             18,
				publisher:       None,
				kind:            ManagedRecoveryKind::Remove,
				created_at_secs: None,
			})
		);
		assert_eq!(
			parse_managed_recovery_name(b".gjc-managed-replace-18-9"),
			Some(ManagedRecoveryName {
				pid:             18,
				publisher:       None,
				kind:            ManagedRecoveryKind::Replace,
				created_at_secs: None,
			})
		);
		assert_eq!(
			parse_managed_recovery_name(
				b".gjc-managed-replace-17-00000000000000000000000000000012-123-9-42"
			),
			Some(ManagedRecoveryName {
				pid:             17,
				publisher:       None,
				kind:            ManagedRecoveryKind::Replace,
				created_at_secs: Some(42),
			})
		);
		let publisher = ManagedPublisherIdentity {
			pid_namespace:    77,
			boot_id:          [0x12; 16],
			start_time_ticks: 123,
		};
		let timestamped = recovery_name_with_publisher(".gjc-managed-replace", 17, publisher, 9, 42);
		assert_eq!(
			parse_managed_recovery_name(timestamped.as_bytes()),
			Some(ManagedRecoveryName {
				pid:             17,
				publisher:       Some(publisher),
				kind:            ManagedRecoveryKind::Replace,
				created_at_secs: Some(42),
			})
		);
		for name in [
			b".gjc-managed-remove-0-9-43".as_slice(),
			b".gjc-managed-remove-018-9-43".as_slice(),
			b".gjc-managed-replace-17-0-43-extra".as_slice(),
			b".gjc-managed-remove-17-x-43".as_slice(),
			b".gjc-managed-replace-17-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX-123-0-42".as_slice(),
			b".gjc-managed-tree-remove-17-9-43".as_slice(),
		] {
			assert_eq!(parse_managed_recovery_name(name), None, "{name:?}");
		}
	}

	#[test]
	fn generated_replacement_names_bind_the_current_process_generation() {
		let pid =
			libc::pid_t::try_from(std::process::id()).expect("test process id fits Linux pid_t");
		let current = linux_process_identity(pid).expect("read current process identity");
		let generated =
			managed_recovery_name(".gjc-managed-replace", 3).expect("generate managed name");
		let parsed = parse_managed_recovery_name(generated.as_bytes()).expect("parse managed name");
		assert_eq!(parsed.pid, pid);
		assert_eq!(parsed.publisher, Some(current));
		assert_eq!(
			parsed.publisher.map(|publisher| publisher.pid_namespace),
			linux_current_pid_namespace_identity(),
		);
		assert_eq!(parsed.kind, ManagedRecoveryKind::Replace);
		assert!(parsed.created_at_secs.is_some());
	}

	#[test]
	fn process_stat_parser_handles_non_utf8_command_names() {
		let mut stat = b"4321 (comm with ) and ".to_vec();
		stat.push(0xff);
		stat.extend_from_slice(b") S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20");
		assert_eq!(parse_linux_process_start_ticks(&stat), Some(19));
	}

	#[test]
	fn reaper_distinguishes_reused_pids_from_the_original_publisher() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = RECOVERY_REAPER_REPLACE_GRACE_SECS + RECOVERY_REAPER_CLOCK_GRACE_SECS + 100_000;
		let expired_at =
			now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS - 1;
		let current = ManagedPublisherIdentity {
			pid_namespace:    44,
			boot_id:          [0x34; 16],
			start_time_ticks: 900,
		};
		let previous = ManagedPublisherIdentity {
			pid_namespace:    44,
			boot_id:          [0x34; 16],
			start_time_ticks: 899,
		};
		let reused_name =
			recovery_name_with_publisher(".gjc-managed-replace", 801, previous, 0, expired_at);
		let live_name =
			recovery_name_with_publisher(".gjc-managed-replace", 801, current, 1, expired_at + 1);
		let same_tick_name =
			recovery_name_with_publisher(".gjc-managed-replace", 802, current, 2, expired_at + 1);
		write_reaper_file(&temporary.0, &reused_name, b"reused", 0o600);
		write_reaper_file(&temporary.0, &live_name, b"live", 0o600);
		write_reaper_file(&temporary.0, &same_tick_name, b"same-tick", 0o600);

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, now, &mut cookie, |candidate| {
			process_generation_is_definitely_different(candidate.publisher, current)
		});
		assert_eq!(metrics.reaped_files, 1);
		assert_eq!(metrics.preserved_candidates, 2);
		assert!(!temporary.0.join(reused_name).exists());
		assert!(temporary.0.join(live_name).exists());
		assert!(temporary.0.join(same_tick_name).exists());

		assert!(!process_generation_is_definitely_different(None, current));
		let after_reboot = ManagedPublisherIdentity {
			pid_namespace:    44,
			boot_id:          [0x35; 16],
			start_time_ticks: 899,
		};
		assert!(process_generation_is_definitely_different(Some(previous), after_reboot));
	}

	#[test]
	fn reaper_only_uses_pid_liveness_evidence_in_the_publisher_namespace() {
		let candidate = ManagedRecoveryName {
			pid:             801,
			publisher:       Some(ManagedPublisherIdentity {
				pid_namespace:    22,
				boot_id:          [0x34; 16],
				start_time_ticks: 900,
			}),
			kind:            ManagedRecoveryKind::Replace,
			created_at_secs: Some(1),
		};
		let observations = Cell::new(0);
		let dead_checks = Cell::new(0);
		let cross_namespace = process_is_definitely_dead_for_candidate_with_observations(
			candidate,
			Some(11),
			|_| {
				observations.set(observations.get() + 1);
				Some(ManagedPublisherIdentity {
					pid_namespace:    11,
					boot_id:          [0x35; 16],
					start_time_ticks: 1,
				})
			},
			|_| {
				dead_checks.set(dead_checks.get() + 1);
				true
			},
		);
		assert!(!cross_namespace);
		assert_eq!(observations.get(), 0);
		assert_eq!(dead_checks.get(), 0);
		assert!(!process_is_definitely_dead_for_candidate_with_observations(
			candidate,
			None,
			|_| panic!("must not inspect a PID without a known reaper namespace"),
			|_| panic!("must not probe a PID without a known reaper namespace"),
		));

		let unobservable_procfs = process_is_definitely_dead_for_candidate_with_observations(
			candidate,
			Some(22),
			|_| None,
			|_| false,
		);
		assert!(!unobservable_procfs, "missing procfs/boot-ID data preserves the candidate");
		assert_eq!(parse_linux_boot_id("00000000-0000-0000-0000-000000000000"), None,);

		let legacy = ManagedRecoveryName { publisher: None, ..candidate };
		assert!(!process_is_definitely_dead_for_candidate_with_observations(
			legacy,
			Some(22),
			|_| None,
			|_| true,
		));
	}

	#[test]
	fn reaper_uses_distinct_replacement_and_removal_retention() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = RECOVERY_REAPER_REMOVE_TTL_SECS
			+ RECOVERY_REAPER_REPLACE_GRACE_SECS
			+ RECOVERY_REAPER_CLOCK_GRACE_SECS
			+ 10_000;
		let remove_age = RECOVERY_REAPER_REMOVE_TTL_SECS + RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let replace_age = RECOVERY_REAPER_REPLACE_GRACE_SECS + RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let entries = [
			(101, ".gjc-managed-replace", "live", replace_age, true),
			(102, ".gjc-managed-remove", "recent", 60 * 60, false),
			(103, ".gjc-managed-remove", "ttl-only", RECOVERY_REAPER_REMOVE_TTL_SECS, false),
			(104, ".gjc-managed-remove", "grace-edge", remove_age - 1, false),
			(105, ".gjc-managed-remove", "remove-expired", remove_age, false),
			(106, ".gjc-managed-replace", "replace-recent", 60 * 60, false),
			(107, ".gjc-managed-replace", "replace-grace-edge", replace_age - 1, false),
			(108, ".gjc-managed-replace", "replace-expired", replace_age, false),
			(109, ".gjc-managed-remove", "live-remove-expired", remove_age, true),
			(110, ".gjc-managed-replace-complete", "live-complete-expired", replace_age, true),
		];
		for &(pid, family, suffix, age, _) in &entries {
			let name = recovery_name(family, pid, 0, now - age);
			write_reaper_file(&temporary.0, &name, suffix.as_bytes(), 0o600);
		}

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, now, &mut cookie, |candidate| {
			candidate.pid != 101 && candidate.pid != 110
		});
		assert_eq!(metrics.reaped_files, 4);
		assert_eq!(
			metrics.reaped_bytes,
			(b"remove-expired".len()
				+ b"replace-expired".len()
				+ b"live-remove-expired".len()
				+ b"live-complete-expired".len()) as u64
		);
		assert_eq!(metrics.preserved_candidates, 6);
		for &(pid, family, suffix, age, _) in &entries {
			let path = temporary.0.join(recovery_name(family, pid, 0, now - age));
			assert_eq!(
				path.exists(),
				pid != 105 && pid != 108 && pid != 109 && pid != 110,
				"{suffix} retention"
			);
		}
	}

	#[test]
	fn reaper_preserves_legacy_malformed_symlink_hardlink_and_untrusted_mode_entries() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = unix_now_secs();
		let stale = now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let mode_name = recovery_name(".gjc-managed-replace", 701, 1, stale);
		write_reaper_file(&temporary.0, &mode_name, b"mode", 0o644);

		let hardlink_source = temporary.0.join("hardlink-source");
		write_reaper_file(&temporary.0, "hardlink-source", b"linked", 0o600);
		let hardlink_name = recovery_name(".gjc-managed-remove", 702, 2, stale);
		fs::hard_link(&hardlink_source, temporary.0.join(&hardlink_name))
			.expect("create recovery hard link");

		let symlink_target = temporary.0.join("symlink-target");
		fs::write(&symlink_target, b"target").expect("write symlink target");
		let symlink_name = recovery_name(".gjc-managed-replace", 703, 3, stale);
		std::os::unix::fs::symlink(&symlink_target, temporary.0.join(&symlink_name))
			.expect("create recovery symlink");

		let legacy_name = ".gjc-managed-remove-704-4";
		write_reaper_file(&temporary.0, legacy_name, b"legacy", 0o600);
		let malformed_name = ".gjc-managed-remove-705-5-not-a-time";
		write_reaper_file(&temporary.0, malformed_name, b"malformed", 0o600);
		let unrelated_name = recovery_name(".gjc-managed-tree-remove", 706, 6, stale);
		write_reaper_file(&temporary.0, &unrelated_name, b"unrelated", 0o600);

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, now, &mut cookie, |_| true);
		assert_eq!(metrics.reaped_files, 0);
		assert_eq!(metrics.reaped_bytes, 0);
		assert_eq!(metrics.preserved_candidates, 4);
		for name in [
			mode_name.as_str(),
			hardlink_name.as_str(),
			symlink_name.as_str(),
			legacy_name,
			malformed_name,
			unrelated_name.as_str(),
		] {
			assert!(temporary.0.join(name).exists(), "{name} must remain");
		}
		assert!(
			fs::symlink_metadata(temporary.0.join(&symlink_name))
				.expect("symlink metadata")
				.file_type()
				.is_symlink()
		);
	}

	#[test]
	fn legacy_recovery_names_use_durable_first_seen_markers_for_bounded_collection() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let name = ".gjc-managed-remove-711-12";
		write_reaper_file(&temporary.0, name, b"legacy-data", 0o600);
		let file = open_existing(&directory, name, false).expect("open legacy recovery file");
		let identity = regular_identity(&file).expect("legacy file identity");
		drop(file);
		let first_seen = unix_now_secs();
		let (recorded, marker) = first_seen_for_legacy_candidate(
			&directory,
			&CString::new(name).expect("legacy name"),
			&identity,
			first_seen,
		)
		.expect("persist first-seen marker");
		assert_eq!(recorded, first_seen);
		assert!(
			temporary
				.0
				.join(marker.name.to_str().expect("marker name"))
				.exists()
		);

		let expired_first_seen = first_seen
			.saturating_sub(RECOVERY_REAPER_REMOVE_TTL_SECS + RECOVERY_REAPER_CLOCK_GRACE_SECS);
		fs::write(
			temporary.0.join(marker.name.to_str().expect("marker name")),
			format!("{expired_first_seen}\n"),
		)
		.expect("age marker for deterministic retention test");
		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, first_seen, &mut cookie, |candidate| {
			candidate.pid == 711
		});
		assert_eq!(metrics.reaped_files, 1);
		assert_eq!(metrics.reaped_bytes, b"legacy-data".len() as u64);
		assert!(!temporary.0.join(name).exists());
		assert!(
			!temporary
				.0
				.join(marker.name.to_str().expect("marker name"))
				.exists()
		);
	}

	#[test]
	fn reaper_sweep_is_bounded_and_reports_removed_file_and_byte_metrics() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = unix_now_secs();
		let stale = now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let total = RECOVERY_REAPER_MAX_SCAN_ENTRIES as u64 + 64;
		for counter in 0..total {
			let name = recovery_name(".gjc-managed-replace", 808, counter, stale);
			write_reaper_file(&temporary.0, &name, b"x", 0o600);
		}

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, now, &mut cookie, |_| true);
		assert_eq!(metrics.scanned_entries, RECOVERY_REAPER_MAX_SCAN_ENTRIES as u64);
		assert_eq!(metrics.reaped_files, RECOVERY_REAPER_MAX_FILES);
		assert_eq!(metrics.reaped_bytes, RECOVERY_REAPER_MAX_FILES);
		assert!(metrics.scan_limited);
		let remaining = fs::read_dir(&temporary.0)
			.expect("read recovery directory")
			.count();
		assert_eq!(remaining, total as usize - RECOVERY_REAPER_MAX_FILES as usize);
	}

	#[test]
	fn reaper_reports_candidates_that_exceed_the_remaining_byte_budget() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = unix_now_secs();
		let stale = now - RECOVERY_REAPER_REMOVE_TTL_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let name = recovery_name(".gjc-managed-remove", 909, 1, stale);
		write_reaper_file(&temporary.0, &name, b"over-budget", 0o600);

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at_with_cursor(
			&directory,
			now,
			&mut cookie,
			8,
			0,
			|_| Ok(()),
			|_| true,
		);
		assert_eq!(metrics.reaped_files, 0);
		assert_eq!(metrics.preserved_candidates, 1);
		assert!(metrics.scan_limited);
		assert!(temporary.0.join(name).exists());
	}

	#[test]
	fn reaper_processes_scanned_candidates_when_persisting_cursor_fails() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = unix_now_secs();
		let expired = now - RECOVERY_REAPER_REMOVE_TTL_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let name = recovery_name(".gjc-managed-remove", 919, 1, expired);
		write_reaper_file(&temporary.0, &name, b"expired", 0o600);

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at_with_cursor(
			&directory,
			now,
			&mut cookie,
			8,
			1024,
			|_| Err("fsync_failed"),
			|_| true,
		);

		assert_eq!(metrics.reaped_files, 1);
		assert_eq!(metrics.reaped_bytes, b"expired".len() as u64);
		assert_eq!(metrics.failures, 1);
		assert!(metrics.scan_limited);
		assert!(!temporary.0.join(name).exists());
	}

	#[test]
	fn reaper_falls_back_to_a_bounded_scan_when_cursor_open_is_unsafe() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let target_name = "cursor-target";
		let cursor_name =
			std::str::from_utf8(RECOVERY_REAPER_CURSOR_NAME).expect("cursor name is valid UTF-8");
		write_reaper_file(&temporary.0, target_name, b"untouched target", 0o600);
		std::os::unix::fs::symlink(target_name, temporary.0.join(cursor_name))
			.expect("create unsafe cursor marker");
		let now = unix_now_secs();
		let expired = now - RECOVERY_REAPER_REMOVE_TTL_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;
		let name = recovery_name(".gjc-managed-remove", 920, 1, expired);
		write_reaper_file(&temporary.0, &name, b"expired", 0o600);
		let state = Arc::new(Mutex::new(RecoveryReaperState::default()));

		let metrics = reap_managed_recovery_with_limits(&directory, &state, true, 8, 1024, |_| true);

		assert_eq!(metrics.reaped_files, 1);
		assert_eq!(metrics.reaped_bytes, b"expired".len() as u64);
		assert_eq!(metrics.failures, 1);
		assert!(metrics.scan_limited);
		assert!(!temporary.0.join(name).exists());
		assert!(
			fs::symlink_metadata(temporary.0.join(cursor_name))
				.expect("cursor marker remains a symlink")
				.file_type()
				.is_symlink()
		);
		assert_eq!(
			fs::read(temporary.0.join(target_name)).expect("cursor target remains untouched"),
			b"untouched target",
		);
	}

	#[test]
	fn reaper_rolls_back_quarantine_link_when_source_unlink_fails() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let now = RECOVERY_REAPER_REMOVE_TTL_SECS + RECOVERY_REAPER_CLOCK_GRACE_SECS + 10_000;
		let created_at = now - RECOVERY_REAPER_REMOVE_TTL_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS - 1;
		let name = recovery_name(".gjc-managed-remove", 929, 1, created_at);
		write_reaper_file(&temporary.0, &name, b"expired evidence", 0o600);
		set_retained_publish_faults([
			RetainedPublishFault::Rename(libc::EINVAL),
			RetainedPublishFault::Unlink(libc::EIO),
		]);

		let mut cookie = 0;
		let metrics = reap_managed_recovery_at(&directory, now, &mut cookie, |_| true);

		assert_eq!(metrics.reaped_files, 0);
		assert_eq!(metrics.failures, 1);
		let source = fs::metadata(temporary.0.join(&name)).expect("source evidence remains");
		assert_eq!(source.nlink(), 1, "failed unlink rolls back only quarantine link");
		assert_eq!(
			fs::read_dir(&temporary.0)
				.expect("recovery directory")
				.count(),
			1,
			"no quarantine hard link remains"
		);
	}

	#[test]
	fn reaper_cursor_continues_after_a_fresh_state_instance() {
		let valid_cursor = reaper_cursor_contents((1, 2), 3);
		assert_eq!(parse_reaper_cursor(valid_cursor.as_bytes(), (1, 2)), Some(3));
		assert_eq!(parse_reaper_cursor(valid_cursor.as_bytes(), (1, 3)), None);
		let mut corrupted_cursor = valid_cursor.as_bytes().to_vec();
		corrupted_cursor[0] = b'9';
		assert_eq!(parse_reaper_cursor(&corrupted_cursor, (1, 2)), None);
		assert_eq!(parse_reaper_cursor(b"corrupt", (1, 2)), None);
		let temporary = TempDir::new();
		let directory = temporary.root();
		let initialization = Arc::new(Mutex::new(RecoveryReaperState::default()));
		let initialized =
			reap_managed_recovery_with_limits(&directory, &initialization, true, 2, 1024, |_| false);
		assert_eq!(initialized.scanned_entries, 0);

		let now = unix_now_secs();
		let stale = now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS - 1;
		let publisher = ManagedPublisherIdentity {
			pid_namespace:    77,
			boot_id:          [0x45; 16],
			start_time_ticks: 123,
		};
		for pid in 900..903 {
			let name =
				recovery_name_with_publisher(".gjc-managed-replace", pid, publisher, pid as u64, stale);
			write_reaper_file(&temporary.0, &name, b"candidate", 0o600);
		}
		let ordered_candidates = fs::read_dir(&temporary.0)
			.expect("read recovery directory")
			.map(|entry| entry.expect("read directory entry").file_name())
			.filter_map(|name| name.into_string().ok())
			.filter(|name| parse_managed_recovery_name(name.as_bytes()).is_some())
			.collect::<Vec<_>>();
		assert_eq!(ordered_candidates.len(), 3);
		let target_name = ordered_candidates[2].clone();
		let target_pid = parse_managed_recovery_name(target_name.as_bytes())
			.expect("target managed name")
			.pid;

		let first_state = Arc::new(Mutex::new(RecoveryReaperState::default()));
		let first =
			reap_managed_recovery_with_limits(&directory, &first_state, true, 2, 1024, |_| false);
		assert_eq!(first.scanned_entries, 2);
		assert_eq!(first.preserved_candidates, 2);
		assert!(temporary.0.join(&target_name).exists());

		let fresh_state = Arc::new(Mutex::new(RecoveryReaperState::default()));
		let continued =
			reap_managed_recovery_with_limits(&directory, &fresh_state, true, 2, 1024, |candidate| {
				candidate.pid == target_pid
			});
		assert_eq!(continued.scanned_entries, 1);
		assert_eq!(continued.reaped_files, 1);
		assert!(!temporary.0.join(target_name).exists());
	}

	#[test]
	fn cold_open_reaches_expired_entries_after_a_preserved_prefix() {
		let temporary = TempDir::new();
		let recovery = temporary.0.join(".gjc-recovery");
		fs::create_dir(&recovery).expect("create recovery directory");
		fs::set_permissions(&recovery, fs::Permissions::from_mode(0o700))
			.expect("secure recovery directory");
		let now = unix_now_secs();
		for counter in 0..700 {
			let name = recovery_name(".gjc-managed-replace", std::process::id(), counter, now);
			write_reaper_file(&recovery, &name, b"live", 0o600);
		}
		let dead_pid = libc::pid_t::MAX;
		if !process_is_definitely_dead(dead_pid) {
			return;
		}
		let publisher = linux_process_identity(
			libc::pid_t::try_from(std::process::id()).expect("test process id fits Linux pid_t"),
		)
		.expect("read current publisher namespace and generation");
		let expired = recovery_name_with_publisher(
			".gjc-managed-replace",
			dead_pid as u32,
			publisher,
			701,
			now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS,
		);
		write_reaper_file(&recovery, &expired, b"expired", 0o600);
		let authority = open_recovery_fs_root(temporary.0.to_string_lossy().into_owned())
			.expect("open recovery root");
		let metrics = authority.recovery_reaper_metrics();
		assert_eq!(
			metrics.reaped_files, "1",
			"scanned={} preserved={} failures={} limited={}",
			metrics.scanned_entries, metrics.preserved_entries, metrics.failures, metrics.scan_limited,
		);
		assert!(!recovery.join(expired).exists());
	}

	#[test]
	fn reaper_throttles_recovery_acquisition_sweeps_without_losing_the_cursor() {
		let temporary = TempDir::new();
		let directory = temporary.root();
		let state = Arc::new(Mutex::new(RecoveryReaperState::default()));
		let initial = reap_managed_recovery(&directory, &state, true);
		assert_eq!(initial.scanned_entries, 0);

		let now = unix_now_secs();
		let live_pid = std::process::id();
		let live_process = linux_process_identity(
			libc::pid_t::try_from(live_pid).expect("test process id fits Linux pid_t"),
		)
		.expect("read current process identity");
		let live_name = recovery_name_with_publisher(
			".gjc-managed-replace",
			live_pid,
			live_process,
			0,
			now - RECOVERY_REAPER_REPLACE_GRACE_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS,
		);
		write_reaper_file(&temporary.0, &live_name, b"live", 0o600);
		let throttled = reap_managed_recovery_if_due(&directory, &state);
		assert_eq!(throttled.scanned_entries, 0);
		assert!(temporary.0.join(&live_name).exists());

		state.lock().last_attempt = Some(Instant::now() - RECOVERY_REAPER_SWEEP_INTERVAL);
		let due = reap_managed_recovery_if_due(&directory, &state);
		assert_eq!(due.scanned_entries, 1);
		assert_eq!(due.preserved_candidates, 1);
		assert!(temporary.0.join(&live_name).exists());
	}

	#[test]
	fn reaper_runs_on_root_open_and_new_recovery_directory_acquisition() {
		let dead_pid = libc::pid_t::MAX;
		if !process_is_definitely_dead(dead_pid) {
			return;
		}
		let publisher = linux_process_identity(
			libc::pid_t::try_from(std::process::id()).expect("test process id fits Linux pid_t"),
		)
		.expect("read current publisher namespace and generation");
		let stale =
			unix_now_secs() - RECOVERY_REAPER_REMOVE_TTL_SECS - RECOVERY_REAPER_CLOCK_GRACE_SECS;

		let on_open = TempDir::new();
		let on_open_recovery = on_open.0.join(".gjc-recovery");
		fs::create_dir(&on_open_recovery).expect("create recovery directory");
		fs::set_permissions(&on_open_recovery, fs::Permissions::from_mode(0o700))
			.expect("secure recovery directory");
		let open_name = recovery_name(".gjc-managed-remove", dead_pid as u32, 0, stale);
		write_reaper_file(&on_open_recovery, &open_name, b"open", 0o600);
		let opened = open_recovery_fs_root(on_open.0.to_string_lossy().into_owned())
			.expect("open recovery root");
		assert!(!on_open_recovery.join(open_name).exists());
		let open_metrics = opened.recovery_reaper_metrics();
		assert!(open_metrics.ok);
		assert_eq!(open_metrics.reaped_files, "1");
		assert_eq!(open_metrics.reaped_bytes, b"open".len().to_string());
		assert_eq!(open_metrics.total_reaped_files, "1");
		drop(opened);

		let on_acquire = TempDir::new();
		let child_path = on_acquire.0.join("child");
		fs::create_dir(&child_path).expect("create retained child");
		fs::set_permissions(&child_path, fs::Permissions::from_mode(0o700))
			.expect("secure retained child");
		let root = open_recovery_fs_root(on_acquire.0.to_string_lossy().into_owned())
			.expect("open root before recovery directory exists");
		let recovery_path = on_acquire.0.join(".gjc-recovery");
		fs::create_dir(&recovery_path).expect("create recovery directory after root open");
		fs::set_permissions(&recovery_path, fs::Permissions::from_mode(0o700))
			.expect("secure recovery directory");
		let acquire_name =
			recovery_name_with_publisher(".gjc-managed-replace", dead_pid as u32, publisher, 1, stale);
		write_reaper_file(&recovery_path, &acquire_name, b"acquire", 0o600);
		let child = File::open(&child_path).expect("open child directory");
		let child_identity = identity(&child).expect("child identity");
		let retained = root
			.retain_managed_directory("child".to_owned(), child_identity.dev, child_identity.ino)
			.expect("retain child directory");
		assert!(!recovery_path.join(acquire_name).exists());
		let acquisition_metrics = root.recovery_reaper_metrics();
		assert!(acquisition_metrics.ok);
		assert_eq!(acquisition_metrics.reaped_files, "1");
		assert_eq!(acquisition_metrics.reaped_bytes, b"acquire".len().to_string());
		drop(retained);
		drop(root);
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
			)
			.expect("replacement must not fail on a filesystem without rename flags");

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
						.starts_with(".gjc-managed-replace-complete-")
				})
				.expect("displaced object retained under the completed family name");
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
			let completed_name = displaced.file_name().to_string_lossy().into_owned();
			let completed = parse_managed_recovery_name(completed_name.as_bytes())
				.expect("completed replacement name parses");
			assert_eq!(completed.kind, ManagedRecoveryKind::CompletedReplace);
			let expiration = completed
				.created_at_secs
				.expect("completed replacement timestamp")
				+ RECOVERY_REAPER_REPLACE_GRACE_SECS
				+ RECOVERY_REAPER_CLOCK_GRACE_SECS;
			let recovery =
				open_existing_directory(&root, ".gjc-recovery").expect("open recovery directory");
			let mut cookie = 0;
			let metrics = reap_managed_recovery_at(&recovery, expiration, &mut cookie, |_| false);
			assert_eq!(
				metrics.reaped_files, 1,
				"live publisher does not exempt completed predecessor"
			);
			assert!(!displaced.path().exists(), "expired completed predecessor is reaped");
		}
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
		exchange_through_link(&parent, &candidate_name, &parent, &destination_name, || {
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
		})
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

	#[test]
	fn replacement_candidate_fallback_rolls_back_its_link_when_source_unlink_fails() {
		let temporary = TempDir::new();
		let parent = temporary.root();
		write_reaper_file(&temporary.0, "staging", b"candidate", 0o600);
		let source_name = CString::new("staging").expect("staging name");
		let destination_name = CString::new("replacement").expect("replacement name");
		set_retained_publish_faults([RetainedPublishFault::ReplacementCandidateUnlink(libc::EIO)]);

		let result = rename_replacement_candidate_no_replace(
			&parent,
			&source_name,
			&parent,
			&destination_name,
			|| (),
		);

		assert_eq!(result, Err("io_error"));
		assert!(temporary.0.join("staging").exists(), "rollback must not delete the source");
		assert!(!temporary.0.join("replacement").exists(), "rollback removes only its new link");
		let source_metadata = fs::metadata(temporary.0.join("staging")).expect("source metadata");
		assert_eq!(source_metadata.nlink(), 1, "source link count is restored");
		assert_eq!(fs::read(temporary.0.join("staging")).expect("source contents"), b"candidate",);
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
		let failure = match replace_managed(
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
		) {
			Ok(_) => panic!("an unprovable rollback link must not publish"),
			Err(code) => code,
		};

		assert_eq!(failure, "durability_not_provable");
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
		)
		.expect_err("destination-parent sync failure must be reported");
		assert_eq!(destination_error, "destination_parent_sync_failed");
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
		)
		.expect_err("candidate-parent sync failure must be reported");
		assert_eq!(candidate_error, "candidate_parent_sync_failed");
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

		exchange_through_link(&parent, &candidate_name, &parent, &destination_name, || {})
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
