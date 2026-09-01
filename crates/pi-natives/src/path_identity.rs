//! Canonical directory identity and fail-closed path security helpers.

#[cfg(any(unix, test))]
use std::io::{self, Read};
use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	path::{Component, Path, PathBuf},
	sync::{
		Arc, OnceLock,
		atomic::{AtomicBool, Ordering},
		mpsc::{SyncSender, sync_channel},
	},
};

use napi::{
	JsString,
	bindgen_prelude::{BigInt, Either, Uint8Array},
};
use napi_derive::napi;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

use crate::task;
/// Classification of a read-only retained-publication observation.
#[napi(object)]
pub struct NativeBrokerPublicationObservation {
	pub kind: String,
}

/// Result of a retained positional heartbeat write or sync.
#[napi(object)]
pub struct NativeBrokerPublicationOperation {
	pub kind: String,
}

/// Retained descriptors plus the serialization state for the two blocking
/// primitives.
///
/// `writer` is acquired **only** on the libuv blocking pool. It is held across
/// an unbounded `pwrite`/`fsync`, so any JS-thread path that took it would
/// inherit that stall -- which is the whole failure this type exists to avoid
/// (#4704). Observation and close therefore never touch it: they need the
/// descriptors, not the write ordering.
struct RetainedPublicationHandle {
	publication: publication::RetainedPublication,
	writer:      Mutex<()>,
	closed:      AtomicBool,
}

impl RetainedPublicationHandle {
	/// Run one blocking primitive under the single-writer lock. Never call this
	/// from the JS thread.
	fn write_serialized(
		&self,
		operation: impl FnOnce(&publication::RetainedPublication) -> String,
	) -> String {
		let _writer = self.writer.lock();
		// Close wins every race it enters: an unresolved worker must not commit a
		// heartbeat against authority the owner has already given up.
		if self.closed.load(Ordering::Acquire) {
			return "closed".to_owned();
		}
		operation(&self.publication)
	}
}

/// Retained no-follow authority for the SDK publication namespace.
#[napi]
pub struct NativeRetainedBrokerPublication {
	/// Locked only long enough to clone or take the pointer, never across native
	/// I/O, so acquiring it is bounded by memory access alone.
	handle: Mutex<Option<Arc<RetainedPublicationHandle>>>,
}

impl NativeRetainedBrokerPublication {
	fn retain(publication: publication::RetainedPublication) -> Self {
		Self {
			handle: Mutex::new(Some(Arc::new(RetainedPublicationHandle {
				publication,
				writer: Mutex::new(()),
				closed: AtomicBool::new(false),
			}))),
		}
	}

	fn acquire(&self) -> Option<Arc<RetainedPublicationHandle>> {
		self.handle.lock().clone()
	}

	/// Drive the pool's heartbeat body on the calling thread. Test-only: nothing
	/// in production may run this off the blocking pool.
	#[cfg(test)]
	fn heartbeat_blocking(&self, heartbeat_at: &str) -> String {
		run_heartbeat(self.acquire(), heartbeat_at)
	}

	/// Drive the pool's sync body on the calling thread. Test-only.
	#[cfg(test)]
	fn sync_blocking(&self) -> String {
		run_sync(self.acquire())
	}
}

/// The heartbeat body the blocking pool runs, shared with native lifecycle
/// tests so they exercise the production path rather than a copy of it.
fn run_heartbeat(handle: Option<Arc<RetainedPublicationHandle>>, heartbeat_at: &str) -> String {
	handle.map_or_else(
		|| "closed".to_owned(),
		|handle| handle.write_serialized(|publication| publication.heartbeat(heartbeat_at)),
	)
}

/// The sync body the blocking pool runs.
fn run_sync(handle: Option<Arc<RetainedPublicationHandle>>) -> String {
	handle.map_or_else(
		|| "closed".to_owned(),
		|handle| handle.write_serialized(publication::RetainedPublication::sync),
	)
}

/// The read-only observation body the blocking pool runs for the watchdog.
fn run_observe(handle: Option<Arc<RetainedPublicationHandle>>) -> String {
	handle.map_or_else(
		|| "ambiguous".to_owned(),
		|handle| {
			if handle.closed.load(Ordering::Acquire) {
				"ambiguous".to_owned()
			} else {
				handle.publication.observe()
			}
		},
	)
}

#[napi]
impl NativeRetainedBrokerPublication {
	/// Read-only observation. Deliberately synchronous: it is the authority
	/// boundary that must not admit an await between proof and effect. It reads
	/// descriptor identity only -- no write, no fsync -- and never takes the
	/// writer lock, so an unresolved heartbeat cannot block it.
	#[napi]
	pub fn observe(&self) -> NativeBrokerPublicationObservation {
		NativeBrokerPublicationObservation {
			kind: self.acquire().map_or_else(
				|| "ambiguous".to_owned(),
				|handle| {
					if handle.closed.load(Ordering::Acquire) {
						"ambiguous".to_owned()
					} else {
						handle.publication.observe()
					}
				},
			),
		}
	}

	/// Read-only observation on the libuv blocking pool for watchdog paths.
	#[napi]
	pub fn observe_async(&self) -> task::Promise<NativeBrokerPublicationObservation> {
		let handle = self.acquire();
		task::blocking("broker_publication_observe", (), move |_| {
			Ok(NativeBrokerPublicationObservation { kind: run_observe(handle) })
		})
	}

	/// Positional heartbeat write on the libuv blocking pool. The write is an
	/// unbounded `pwrite` against retained authority: on the JS thread a stalled
	/// filesystem would freeze the whole process, including the timers that are
	/// supposed to notice the stall.
	#[napi]
	pub fn heartbeat_async(
		&self,
		heartbeat_at: String,
	) -> task::Promise<NativeBrokerPublicationOperation> {
		let handle = self.acquire();
		task::blocking("broker_publication_heartbeat", (), move |_| {
			Ok(NativeBrokerPublicationOperation { kind: run_heartbeat(handle, &heartbeat_at) })
		})
	}

	/// `fsync` on the libuv blocking pool. It returns when the device says so,
	/// which is never bounded, so it may not run on the JS thread either.
	#[napi]
	pub fn sync_async(&self) -> task::Promise<NativeBrokerPublicationOperation> {
		let handle = self.acquire();
		task::blocking("broker_publication_sync", (), move |_| {
			Ok(NativeBrokerPublicationOperation { kind: run_sync(handle) })
		})
	}

	/// Give up discovery, owner record, lock directory, and SDK root authority.
	///
	/// Detaches the handle without waiting for anything: an unresolved worker
	/// keeps its own `Arc` alive, observes the closed flag, and returns `closed`
	/// without committing, and the descriptors are released when that last
	/// reference drops on the pool thread. A shutdown blocked behind an
	/// unbounded write is exactly the wedge this must not reproduce.
	#[napi]
	pub fn close(&self) -> NativeBrokerPublicationOperation {
		// The guard is dropped on this statement, before the flag store, so the
		// handle lock is never held across anything but the take itself.
		let detached = self.handle.lock().take();
		if let Some(handle) = detached {
			handle.closed.store(true, Ordering::Release);
		}
		NativeBrokerPublicationOperation { kind: "closed".to_owned() }
	}
}

/// Retain the existing no-follow SDK publication objects after one-time
/// publication.
#[napi]
pub fn retain_broker_publication(
	agent_dir: String,
) -> napi::Result<NativeRetainedBrokerPublication> {
	let publication =
		publication::RetainedPublication::open(Path::new(&agent_dir)).map_err(|failure| {
			napi::Error::from_reason(format!(
				"Retained broker publication authority is unavailable. [retained-publication \
				 object={}; reason={}]",
				failure.object, failure.reason
			))
		})?;
	Ok(NativeRetainedBrokerPublication::retain(publication))
}

/// Result of resolving an existing directory to its stable platform identity.
#[napi(object)]
pub struct NativeCanonicalDirectoryIdentity {
	pub ok:             bool,
	pub platform:       Option<String>,
	pub canonical_path: Option<String>,
	pub code:           Option<String>,
}

/// Evidence for one Linux POSIX ACL attribute.
#[napi(object)]
pub struct NativeAclAttributeEvidence {
	pub clear: String,
	pub query: String,
}

/// Bounded Linux POSIX ACL evidence for an owner-only result.
#[napi(object)]
pub struct NativeAclEvidence {
	pub access:  NativeAclAttributeEvidence,
	pub default: Option<NativeAclAttributeEvidence>,
}

/// Result of applying or checking owner-only path security.
#[napi(object)]
pub struct NativeOwnerOnlySecurityResult {
	pub ok:           bool,
	pub platform:     Option<String>,
	pub kind:         Option<String>,
	pub protocol:     Option<String>,
	pub acl_evidence: Option<NativeAclEvidence>,
	pub code:         Option<String>,
	pub operation:    Option<String>,
	pub attribute:    Option<String>,
}

/// Caller-supplied identity and preauthorized quarantine evidence for exact
/// deletion.

#[napi(object)]
pub struct NativeExactFileIdentity {
	pub dev:             BigInt,
	pub ino:             BigInt,
	pub nlink:           Option<BigInt>,
	pub parent_dev:      Option<BigInt>,
	pub parent_ino:      Option<BigInt>,
	pub size:            BigInt,
	pub mtime_ns:        BigInt,
	/// When true, atomically detach a directory rather than deleting a regular
	/// file.
	pub directory:       Option<bool>,
	/// Keep a regular file in quarantine after its identity has been verified
	/// instead of unlinking it. This makes cross-device retirement recoverable.
	pub detach_only:     Option<bool>,
	/// A caller-persisted, single-component no-replace quarantine destination.
	/// Required for every exact deletion so authority survives a post-detach
	/// crash.
	pub quarantine_name: Option<String>,
	/// SHA-256 of regular-file bytes. Required for regular-file deletion and
	/// verified from the detached object before unlinking it.
	pub sha256:          Option<String>,
	/// Permit removing exactly this authorized pathname when the inode has other
	/// hard links. Remaining links are retained after exact quarantine cleanup.
	pub allow_hard_link: Option<bool>,
}

#[derive(Clone)]
struct ExactFileIdentity {
	dev:             u64,
	ino:             u64,
	nlink:           Option<u64>,
	parent_dev:      Option<u64>,
	parent_ino:      Option<u64>,
	size:            u64,
	mtime_ns:        i64,
	directory:       bool,
	detach_only:     bool,
	quarantine_name: Option<String>,
	sha256:          Option<[u8; 32]>,
	allow_hard_link: bool,
}
/// Typed result of an identity-bound regular-file deletion or directory detach.
#[napi(object)]
pub struct NativeExactUnlinkResult {
	pub ok: bool,
	pub code: Option<String>,
	/// True only when retained directory payloads were descriptor-scrubbed and
	/// every file plus containing directory namespace was fsynced before return.
	pub payload_durable: Option<bool>,
	/// On Windows this is returned in the caller's namespace; retained handle
	/// operations continue to use the volume-GUID canonical path internally.
	pub detached_path: Option<String>,
	pub retained_successor_path: Option<String>,
	/// An internal exchange-placeholder cleanup entry retained after cleanup
	/// could not complete. This is never a canonical publisher successor and
	/// remains recoverable only at this path.
	pub retained_placeholder_path: Option<String>,
	/// A retained cleanup entry whose identity could not be verified. This is
	/// neither a stale detached object nor a publisher successor.
	pub retained_unknown_path: Option<String>,
	/// Hex-formatted Windows NTSTATUS of the underlying pre-mutation failure
	/// (e.g. `0xC0000043` for `STATUS_SHARING_VIOLATION`). Path-free by design;
	/// always absent on success, on non-Windows platforms, and after any
	/// namespace mutation.
	pub windows_error_code: Option<String>,
}

/// Bounded, path-free evidence for one publish operation.
#[napi(object)]
pub struct NativePublishSyncFailure {
	pub phase:       String,
	pub parent_role: String,
	pub os_code:     i32,
	pub kind:        String,
}

/// Bounded, path-free evidence for one publish operation.
#[napi(object)]
pub struct NativePublishDiagnostic {
	pub schema_version:   u32,
	pub collection_state: String,
	pub os_code:          Option<i32>,
	pub sync_failures:    Option<Vec<NativePublishSyncFailure>>,
}

/// Dedicated result for an atomic no-replace namespace publication.
#[napi(object)]
pub struct NativeNoReplaceResult {
	pub ok:               bool,
	pub code:             Option<String>,
	pub mutation_state:   String,
	pub durability_state: String,
	pub reason:           String,
	pub primitive:        String,
	pub phase:            String,
	pub diagnostic:       NativePublishDiagnostic,
}

impl NativeNoReplaceResult {
	fn from_exact(result: NativeExactUnlinkResult) -> Self {
		Self::from_exact_with_primitive(result, None)
	}

	fn from_exact_with_primitive(result: NativeExactUnlinkResult, primitive: Option<&str>) -> Self {
		let (mutation_state, durability_state, reason) = if result.ok {
			// A direct no-replace rename commits the namespace mutation, but does not
			// fsync either parent directory.
			("committed", "not_attempted", "none")
		} else {
			match result.code.as_deref() {
				Some("quarantine_collision" | "already_exists") => {
					("not_committed", "not_attempted", "destination_exists")
				},
				Some("atomic_unavailable") => ("not_committed", "not_attempted", "atomic_unavailable"),
				Some("cross_device") => ("not_committed", "not_attempted", "cross_device"),
				Some("permission_denied") => ("not_committed", "not_attempted", "permission_denied"),
				Some("not_found" | "invalid_request") => {
					("not_committed", "not_attempted", "invalid_request")
				},
				Some("destination_identity_changed") => {
					("committed", "not_provable", "identity_violation")
				},
				Some("reparse_point" | "identity_mismatch" | "not_directory" | "not_regular_file") => {
					("not_committed", "not_attempted", "identity_violation")
				},
				// A signal landing before the syscall entered the kernel (or between
				// retries exhausting the bounded restart loop) never mutates the
				// filesystem: rename()/renameat2()/renameatx_np() are not partially
				// observable on EINTR for local filesystems, unlike e.g. close().
				Some("interrupted") => ("not_committed", "not_attempted", "interrupted"),
				// Unclassified failures leave the syscall's namespace effect
				// ambiguous. Never authorize staging cleanup from them.
				_ => ("unknown", "not_provable", "unknown"),
			}
		};
		Self {
			ok:               result.ok,
			code:             result.code,
			mutation_state:   mutation_state.to_owned(),
			durability_state: durability_state.to_owned(),
			reason:           reason.to_owned(),
			primitive:        primitive.map_or_else(
				|| {
					if cfg!(target_os = "linux") {
						"renameat2_noreplace"
					} else if cfg!(target_os = "macos") {
						"renameatx_np_excl"
					} else if cfg!(windows) {
						"windows_rename_noreplace"
					} else {
						"unsupported"
					}
					.to_owned()
				},
				str::to_owned,
			),
			phase:            if mutation_state == "committed" && !result.ok {
				"terminal_identity"
			} else if mutation_state == "committed" {
				"complete"
			} else if matches!(reason, "invalid_request" | "identity_violation") {
				"preflight"
			} else {
				"rename"
			}
			.to_owned(),
			diagnostic:       NativePublishDiagnostic {
				schema_version:   1,
				collection_state: "unavailable".to_owned(),
				os_code:          None,
				sync_failures:    None,
			},
		}
	}
}

/// Result of a descriptor-relative native skill write.
///
/// The operation is intentionally narrower than a general path write: callers
/// provide one absolute skills root and one validated skill name, and the
/// native side creates/writes only that skill's `SKILL.md` entry.
#[napi(object)]
pub struct NativeSecureSkillWriteResult {
	pub ok:   bool,
	pub path: Option<String>,
	pub code: Option<String>,
}

impl NativeSecureSkillWriteResult {
	const fn success(path: String) -> Self {
		Self { ok: true, path: Some(path), code: None }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, path: None, code: Some(code.to_owned()) }
	}
}

/// A deterministic, no-follow description of a directory tree. `relative_path`
/// is UTF-8, uses `/` separators, and is empty only for the root entry.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]

pub struct NativeDirectoryTreeEntry {
	pub relative_path: String,
	pub kind:          String,
	pub dev:           String,
	pub ino:           String,
	pub nlink:         String,
	pub size:          String,
	pub mtime_ns:      String,
	pub ctime_ns:      String,
	pub sha256:        Option<String>,
}

/// Stable evidence returned by `snapshot_directory_tree` and consumed verbatim
/// by `exact_remove_directory_tree`.
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NativeDirectoryTreeSnapshot {
	pub root_dev: String,
	pub root_ino: String,
	pub entries:  Vec<NativeDirectoryTreeEntry>,
}

#[napi(object)]
pub struct NativeDirectoryParentIdentity {
	pub dev: BigInt,
	pub ino: BigInt,
}

#[napi(object)]
pub struct NativeDirectoryTreeResult {
	pub ok:       bool,
	pub code:     Option<String>,
	pub snapshot: Option<NativeDirectoryTreeSnapshot>,
}

impl NativeDirectoryTreeResult {
	const fn success(snapshot: NativeDirectoryTreeSnapshot) -> Self {
		Self { ok: true, code: None, snapshot: Some(snapshot) }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()), snapshot: None }
	}
}
impl NativeExactUnlinkResult {
	const fn success() -> Self {
		Self {
			ok: true,
			code: None,
			payload_durable: None,
			detached_path: None,
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	const fn detached(path: String) -> Self {
		Self {
			ok: true,
			code: None,
			payload_durable: None,
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	fn detached_failure(code: &str, path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn detached_failure_with_durable_payload(code: &str, path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: Some(true),
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn detached_failure_with_durable_payload_and_placeholder(
		code: &str,
		path: String,
		placeholder_path: String,
	) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: Some(true),
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: Some(placeholder_path),
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn detached_failure_with_durable_payload_and_unknown(
		code: &str,
		path: String,
		unknown_path: String,
	) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: Some(true),
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: Some(unknown_path),
			windows_error_code: None,
		}
	}

	#[cfg(windows)]
	fn detached_failure_with_successor_and_placeholder(
		code: &str,
		path: String,
		successor_path: String,
		placeholder_path: String,
	) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: Some(path),
			retained_successor_path: Some(successor_path),
			retained_placeholder_path: Some(placeholder_path),
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn with_retained_successor_and_expected_detached(
		mut self,
		successor_path: String,
		expected_detached_path: String,
	) -> Self {
		self.retained_successor_path = Some(successor_path);
		if self.detached_path.is_none() {
			self.detached_path = Some(expected_detached_path);
		}
		self
	}

	#[cfg(unix)]
	fn detached_failure_with_placeholder(
		code: &str,
		path: String,
		placeholder_path: String,
	) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: Some(placeholder_path),
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn detached_failure_with_unknown(code: &str, path: String, unknown_path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: Some(path),
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: Some(unknown_path),
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn retained_successor_failure(code: &str, successor_path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: None,
			retained_successor_path: Some(successor_path),
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn retained_placeholder_failure(code: &str, placeholder_path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: None,
			retained_successor_path: None,
			retained_placeholder_path: Some(placeholder_path),
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[cfg(unix)]
	fn retained_unknown_failure(code: &str, unknown_path: String) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: None,
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: Some(unknown_path),
			windows_error_code: None,
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok: false,
			code: Some(code.to_owned()),
			payload_durable: None,
			detached_path: None,
			retained_successor_path: None,
			retained_placeholder_path: None,
			retained_unknown_path: None,
			windows_error_code: None,
		}
	}

	#[allow(dead_code, reason = "used only by the Windows exact-replace retry path")]
	/// Attach path-free Windows NTSTATUS evidence to a pre-mutation failure.
	/// Only call sites that have not touched the namespace may use this; a
	/// post-mutation failure already carries its detached/retained paths.
	fn with_windows_error_code(mut self, windows_error_code: String) -> Self {
		self.windows_error_code = Some(windows_error_code);
		self
	}
}

#[cfg(any(windows, test))]
/// STATUS_SHARING_VIOLATION: a concurrent handle denies the share mode this
/// open requested. This is the Windows transient conflict issue #4330 exists
/// for: another holder without delete sharing makes the exact-replace
/// destination `NtCreateFile` fail before any namespace mutation, and the
/// failure disappears as soon as the holder releases. Every other NTSTATUS is
/// surfaced unchanged.
const STATUS_SHARING_VIOLATION: i32 = 0xc000_0043u32 as i32;

#[cfg(any(windows, test))]
/// True only for pre-mutation Windows failures that are transient and safe to
/// retry at the exact-replace destination open. Sharing violations happen
/// before anything was renamed or unlinked, so retrying cannot publish twice;
/// permission, path, disk-full, and identity failures are never retried.
const fn is_retryable_exact_replace_status(status: i32) -> bool {
	status == STATUS_SHARING_VIOLATION
}

#[cfg(windows)]
/// STATUS_INVALID_PARAMETER: the synthetic NTSTATUS used for early,
/// pre-syscall name validation rejections in the status-returning open path
/// (e.g. an embedded NUL or an oversized name), which never reach
/// `NtCreateFile` and so have no real NTSTATUS to report. Distinct from
/// `STATUS_SHARING_VIOLATION` and never retried.
const STATUS_INVALID_PARAMETER: i32 = 0xc000_000du32 as i32;

/// Bound on transient retries for the exact-replace destination open on
/// Windows, matching the reporter's controlled 30 x 100 ms reproduction window
/// (~1.2 s of contention) with margin. The delay keeps the retry hot loop from
/// busy-spinning the persistence fence; the bound keeps a persistent holder
/// from freezing a session for more than ~3 s.
#[cfg(any(windows, test))]
const EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT: u32 = 30;
#[cfg(any(windows, test))]
const EXACT_REPLACE_DESTINATION_OPEN_RETRY_DELAY_MS: u64 = 100;

#[cfg(any(windows, test))]
/// Open a Windows handle with bounded transient retry on sharing violations.
/// `open` returns the raw NTSTATUS on failure; only
/// [`is_retryable_exact_replace_status`] failures are retried, and only up to
/// [`EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT`] attempts with a bounded delay
/// between them. This is the narrow pre-mutation syscall boundary: the caller
/// must ensure nothing has been renamed or unlinked before the open.
fn open_with_transient_retry<T>(mut open: impl FnMut() -> Result<T, i32>) -> Result<T, i32> {
	for attempt in 0..EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT {
		match open() {
			Ok(handle) => return Ok(handle),
			Err(status)
				if is_retryable_exact_replace_status(status)
					&& attempt + 1 < EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT =>
			{
				std::thread::sleep(std::time::Duration::from_millis(
					EXACT_REPLACE_DESTINATION_OPEN_RETRY_DELAY_MS,
				));
			},
			Err(status) => return Err(status),
		}
	}
	unreachable!("the retry bound guarantees at least one attempt")
}

#[cfg(any(windows, test))]
/// Path-free, hex-formatted Windows NTSTATUS evidence for a pre-mutation
/// failure, e.g. `0xC0000043` for STATUS_SHARING_VIOLATION.
fn native_windows_error_code(status: i32) -> String {
	format!("0x{status:08X}")
}

#[cfg(test)]
mod exact_replace_windows_retry_policy_tests {
	use super::{
		EXACT_REPLACE_DESTINATION_OPEN_RETRY_DELAY_MS, EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT,
		STATUS_SHARING_VIOLATION, is_retryable_exact_replace_status, native_windows_error_code,
		open_with_transient_retry,
	};

	#[test]
	fn retry_policy_accepts_only_sharing_violations() {
		assert!(is_retryable_exact_replace_status(STATUS_SHARING_VIOLATION));
		// Permission, path-not-found, disk-full, and identity failures are never
		// retried: none of them is a transient holder release.
		for status in [
			0xc000_0022u32 as i32,
			0xc000_0034u32 as i32,
			0xc000_003au32 as i32,
			0xc000_007fu32 as i32,
			0xc000_000du32 as i32,
		] {
			assert!(!is_retryable_exact_replace_status(status), "0x{status:08X} must not retry");
		}
		assert!(!is_retryable_exact_replace_status(0));
	}

	#[test]
	fn retry_budget_and_delay_are_bounded() {
		assert_eq!(EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT, 30);
		assert_eq!(EXACT_REPLACE_DESTINATION_OPEN_RETRY_DELAY_MS, 100);
	}

	#[test]
	fn windows_error_code_is_hex_and_path_free() {
		assert_eq!(native_windows_error_code(STATUS_SHARING_VIOLATION), "0xC0000043");
		assert_eq!(native_windows_error_code(0xc000_0022u32 as i32), "0xC0000022");
	}

	#[test]
	fn transient_retry_succeeds_once_the_holder_releases() {
		let mut failures = 3;
		let attempts = std::cell::Cell::new(0);
		let opened = open_with_transient_retry(|| {
			attempts.set(attempts.get() + 1);
			if failures > 0 {
				failures -= 1;
				Err(STATUS_SHARING_VIOLATION)
			} else {
				Ok(42u8)
			}
		});
		assert_eq!(opened, Ok(42u8));
		assert_eq!(attempts.get(), 4, "3 retryable failures then success");
	}

	#[test]
	fn transient_retry_exhausts_the_budget_and_reports_the_status() {
		let attempts = std::cell::Cell::new(0);
		let opened: Result<u8, i32> = open_with_transient_retry(|| {
			attempts.set(attempts.get() + 1);
			Err(STATUS_SHARING_VIOLATION)
		});
		assert_eq!(opened, Err(STATUS_SHARING_VIOLATION));
		assert_eq!(attempts.get(), EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT);
	}

	#[test]
	fn non_retryable_failures_return_without_retrying() {
		let attempts = std::cell::Cell::new(0);
		let opened: Result<u8, i32> = open_with_transient_retry(|| {
			attempts.set(attempts.get() + 1);
			Err(0xc000_0022u32 as i32)
		});
		assert_eq!(opened, Err(0xc000_0022u32 as i32));
		assert_eq!(attempts.get(), 1, "non-sharing failures are never retried");
	}
}

fn parse_sha256(value: Option<&String>) -> Option<[u8; 32]> {
	let value = value?;
	if value.len() != 64 {
		return None;
	}
	let mut digest = [0u8; 32];
	for (index, byte) in digest.iter_mut().enumerate() {
		let pair = value.get(index * 2..index * 2 + 2)?;
		*byte = u8::from_str_radix(pair, 16).ok()?;
	}
	Some(digest)
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
	let mut hasher = Sha256::new();
	hasher.update(bytes);
	hasher.finalize().into()
}

#[cfg(any(unix, test))]
pub(crate) fn digest_reader(reader: &mut impl Read) -> io::Result<[u8; 32]> {
	let mut hasher = Sha256::new();
	let mut chunk = [0u8; 16 * 1024];
	loop {
		let read = reader.read(&mut chunk)?;
		if read == 0 {
			return Ok(hasher.finalize().into());
		}
		hasher.update(&chunk[..read]);
	}
}

fn exact_file_identity(identity: &NativeExactFileIdentity) -> Option<ExactFileIdentity> {
	let (dev_negative, dev, dev_lossless) = identity.dev.get_u64();
	let (ino_negative, ino, ino_lossless) = identity.ino.get_u64();
	let nlink = match identity.nlink.as_ref() {
		Some(value) => {
			let (negative, value, lossless) = value.get_u64();
			if negative || !lossless {
				return None;
			}
			Some(value)
		},
		None => None,
	};
	let (parent_dev, parent_ino) = match (identity.parent_dev.as_ref(), identity.parent_ino.as_ref())
	{
		(Some(dev), Some(ino)) => {
			let (dev_negative, dev, dev_lossless) = dev.get_u64();
			let (ino_negative, ino, ino_lossless) = ino.get_u64();
			if dev_negative || ino_negative || !dev_lossless || !ino_lossless {
				return None;
			}
			(Some(dev), Some(ino))
		},
		(None, None) => (None, None),
		_ => return None,
	};
	let (size_negative, size, size_lossless) = identity.size.get_u64();
	let (mtime_ns, mtime_lossless) = identity.mtime_ns.get_i64();
	if dev_negative
		|| ino_negative
		|| size_negative
		|| !dev_lossless
		|| !ino_lossless
		|| !size_lossless
		|| !mtime_lossless
	{
		return None;
	}
	let quarantine_name = identity.quarantine_name.as_ref().and_then(|name| {
		let path = Path::new(name);
		match path.components().next() {
			Some(Component::Normal(component)) if path.components().count() == 1 => component
				.to_str()
				.filter(|component| !component.is_empty())
				.map(str::to_owned),
			_ => None,
		}
	});
	let sha256 = if identity.directory.unwrap_or(false) {
		None
	} else {
		Some(parse_sha256(identity.sha256.as_ref())?)
	};

	Some(ExactFileIdentity {
		dev,
		ino,
		nlink,
		parent_dev,
		parent_ino,
		size,
		mtime_ns,
		directory: identity.directory.unwrap_or(false),
		detach_only: identity.detach_only.unwrap_or(false),
		quarantine_name,
		sha256,
		allow_hard_link: identity.allow_hard_link.unwrap_or(false),
	})
}
impl NativeCanonicalDirectoryIdentity {
	fn success(platform: &str, canonical_path: String) -> Self {
		Self {
			ok:             true,
			platform:       Some(platform.to_owned()),
			canonical_path: Some(canonical_path),
			code:           None,
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok:             false,
			platform:       None,
			canonical_path: None,
			code:           Some(code.to_owned()),
		}
	}
}

impl NativeOwnerOnlySecurityResult {
	const fn is_ok(&self) -> bool {
		self.ok
	}

	#[allow(dead_code, reason = "used by non-Linux platform implementations")]
	const fn success() -> Self {
		Self {
			ok:           true,
			platform:     None,
			kind:         None,
			protocol:     None,
			acl_evidence: None,
			code:         None,
			operation:    None,
			attribute:    None,
		}
	}

	#[cfg(target_os = "linux")]
	fn linux_success(
		kind: &str,
		access_clear: &str,
		access_query: &str,
		default_evidence: Option<(&str, &str)>,
	) -> Self {
		Self {
			ok:           true,
			platform:     Some("linux".to_owned()),
			kind:         Some(kind.to_owned()),
			protocol:     Some("apply".to_owned()),
			acl_evidence: Some(NativeAclEvidence {
				access:  NativeAclAttributeEvidence {
					clear: access_clear.to_owned(),
					query: access_query.to_owned(),
				},
				default: default_evidence.map(|(clear, query)| NativeAclAttributeEvidence {
					clear: clear.to_owned(),
					query: query.to_owned(),
				}),
			}),
			code:         None,
			operation:    None,
			attribute:    None,
		}
	}

	#[cfg(target_os = "linux")]
	fn linux_verified_success(kind: &str, access_query: &str, default_query: Option<&str>) -> Self {
		Self {
			ok:           true,
			platform:     Some("linux".to_owned()),
			kind:         Some(kind.to_owned()),
			protocol:     Some("verify".to_owned()),
			acl_evidence: Some(NativeAclEvidence {
				access:  NativeAclAttributeEvidence {
					clear: "not_run".to_owned(),
					query: access_query.to_owned(),
				},
				default: default_query.map(|query| NativeAclAttributeEvidence {
					clear: "not_run".to_owned(),
					query: query.to_owned(),
				}),
			}),
			code:         None,
			operation:    None,
			attribute:    None,
		}
	}

	fn failure(code: &str) -> Self {
		Self {
			ok:           false,
			platform:     None,
			kind:         None,
			protocol:     None,
			acl_evidence: None,
			code:         Some(code.to_owned()),
			operation:    None,
			attribute:    None,
		}
	}

	#[cfg(target_os = "linux")]
	fn acl_failure(operation: &str, attribute: &str, category: &str) -> Self {
		let code = match category {
			"denied" => "acl_denied",
			"io_error" => "acl_io_error",
			"present" => "acl_present",
			"malformed" => "acl_malformed",
			_ => "acl_unknown",
		};
		Self {
			ok:           false,
			platform:     None,
			kind:         None,
			protocol:     None,
			acl_evidence: None,
			code:         Some(code.to_owned()),
			operation:    Some(operation.to_owned()),
			attribute:    Some(attribute.to_owned()),
		}
	}
}

#[cfg(unix)]
fn io_code(error: &io::Error) -> &'static str {
	match error.kind() {
		io::ErrorKind::NotFound => "not_found",
		io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => "not_directory",
		_ => "io_error",
	}
}

#[cfg(unix)]
fn security_io_code(error: &io::Error) -> &'static str {
	match error.kind() {
		io::ErrorKind::NotFound => "not_found",
		io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => "not_directory",
		_ => "io_error",
	}
}

#[napi]
pub fn canonical_existing_directory_identity(
	path: Either<JsString, Uint8Array>,
) -> NativeCanonicalDirectoryIdentity {
	let path = match path {
		Either::A(path) => match path
			.into_utf8()
			.and_then(|value| value.as_str().map(str::to_owned))
		{
			Ok(path) if !path.contains('\0') => PathBuf::from(path),
			_ => return NativeCanonicalDirectoryIdentity::failure("io_error"),
		},
		Either::B(path) => {
			#[cfg(unix)]
			let path = path_from_bytes(path.as_ref());
			#[cfg(not(unix))]
			let Some(path) = path_from_bytes(path.as_ref()) else {
				return NativeCanonicalDirectoryIdentity::failure("io_error");
			};
			path
		},
	};
	platform::canonical_existing_directory_identity(&path)
}

#[napi]
pub fn apply_owner_only_path_security(path: String, kind: String) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::apply_owner_only_path_security(Path::new(&path), &kind)
}

#[napi]
pub fn verify_owner_only_path_security(
	path: String,
	kind: String,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::verify_owner_only_path_security(Path::new(&path), &kind)
}
/// Verify owner-only ACL security without mutation only when the retained
/// no-follow handle identifies the expected object before and after inspection.
#[napi]
pub fn verify_owner_only_path_security_expected(
	path: String,
	kind: String,
	expected_dev: BigInt,
	expected_ino: BigInt,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	let (dev_negative, expected_dev, dev_lossless) = expected_dev.get_u64();
	let (ino_negative, expected_ino, ino_lossless) = expected_ino.get_u64();
	if dev_negative || ino_negative || !dev_lossless || !ino_lossless {
		return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
	}
	platform::verify_owner_only_path_security_expected(
		Path::new(&path),
		&kind,
		expected_dev,
		expected_ino,
	)
}

/// Repair an owner-only ACL on a retained expected path.
///
/// Its no-follow handle must still identify the expected object before repair
/// and again after final ACL verification.
#[napi]
pub fn repair_owner_only_path_security_expected(
	path: String,
	kind: String,
	expected_dev: BigInt,
	expected_ino: BigInt,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	let (dev_negative, expected_dev, dev_lossless) = expected_dev.get_u64();
	let (ino_negative, expected_ino, ino_lossless) = expected_ino.get_u64();
	if dev_negative || ino_negative || !dev_lossless || !ino_lossless {
		return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
	}
	platform::repair_owner_only_path_security_expected(
		Path::new(&path),
		&kind,
		expected_dev,
		expected_ino,
	)
}

/// Apply owner-only security to the exact caller descriptor and its retained
/// no-follow path. The descriptor is duplicated with close-on-exec and is never
/// returned to JavaScript.
#[napi]
pub fn apply_owner_only_fd_security(
	path: String,
	kind: String,
	caller_fd: i32,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::apply_owner_only_fd_security(Path::new(&path), &kind, caller_fd)
}

/// Verify owner-only security for the exact caller descriptor and retained
/// no-follow path. The descriptor is duplicated with close-on-exec and is never
/// returned to JavaScript.
#[napi]
pub fn verify_owner_only_fd_security(
	path: String,
	kind: String,
	caller_fd: i32,
) -> NativeOwnerOnlySecurityResult {
	if path.contains('\0') {
		return NativeOwnerOnlySecurityResult::failure("io_error");
	}
	platform::verify_owner_only_fd_security(Path::new(&path), &kind, caller_fd)
}

/// Delete only the regular file that still has the supplied platform identity.
///
/// This never follows a symlink or reparse point in the target path and reports
/// validation failures as typed results rather than deleting a replacement.
#[napi]
pub fn exact_unlink(path: String, identity: NativeExactFileIdentity) -> NativeExactUnlinkResult {
	if path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let Some(identity) = exact_file_identity(&identity) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	platform::exact_unlink(Path::new(&path), &identity)
}

/// Delete only the regular file that still has the supplied platform identity,
/// without the exchange/quarantine protocol used by [`exact_unlink`].
///
/// This is reserved for already-detached inert debris: the operation first
/// moves the pathname to the caller's private no-replace quarantine, verifies
/// the moved object, and only then unlinks that private name. A successor
/// published at the original pathname is therefore never consumed by cleanup,
/// and this path cannot manufacture another exchange placeholder.
#[napi]
pub fn exact_unlink_direct(
	path: String,
	identity: NativeExactFileIdentity,
) -> NativeExactUnlinkResult {
	if path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let Some(identity) = exact_file_identity(&identity) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	platform::exact_unlink_direct(Path::new(&path), &identity)
}

/// Atomically replace a staged regular file only after validating the exact
/// staged source and expected destination.
///
/// Both identities must describe regular files in the same retained parent, not
/// directories or detach-only requests. Publication uses an atomic namespace
/// exchange so a substituted source or destination is never overwritten.
#[napi]
pub fn exact_replace_path(
	source_path: String,
	destination_path: String,
	expected_source: NativeExactFileIdentity,
	expected_destination: NativeExactFileIdentity,
) -> NativeExactUnlinkResult {
	if source_path.contains('\0') || destination_path.contains('\0') {
		return NativeExactUnlinkResult::failure("invalid_request");
	}
	let Some(expected_source) = exact_file_identity(&expected_source) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	let Some(expected_destination) = exact_file_identity(&expected_destination) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	#[cfg(any(unix, windows))]
	{
		platform::exact_replace_path(
			Path::new(&source_path),
			Path::new(&destination_path),
			&expected_source,
			&expected_destination,
		)
	}

	#[cfg(not(any(unix, windows)))]
	{
		let _ = (source_path, destination_path, expected_source, expected_destination);
		NativeExactUnlinkResult::failure("unsupported_platform")
	}
}

/// Start direct exact unlink without retaining an N-API task or promise.
///
/// Cleanup is best effort: the detached operation is intentionally abandoned
/// when the process exits, while the exact identity checks still protect any
/// pathname that remains alive long enough to be examined. A bounded queue
/// keeps cleanup bursts from spawning an unbounded number of OS threads; work
/// that cannot be queued is left for the owning reconciliation pass.
#[napi]
pub fn exact_unlink_direct_detached(path: String, identity: NativeExactFileIdentity) -> bool {
	let queue = detached_cleanup_sender();
	queue.worker_started && queue.sender.try_send((path, identity)).is_ok()
}

type DetachedCleanupJob = (String, NativeExactFileIdentity);

struct DetachedCleanupQueue {
	sender:         SyncSender<DetachedCleanupJob>,
	worker_started: bool,
}

fn detached_cleanup_sender() -> &'static DetachedCleanupQueue {
	static QUEUE: OnceLock<DetachedCleanupQueue> = OnceLock::new();
	QUEUE.get_or_init(|| {
		let (sender, receiver) = sync_channel::<DetachedCleanupJob>(64);
		let worker_started = std::thread::Builder::new()
			.name("pi-natives-exact-unlink-cleanup".to_owned())
			.spawn(move || {
				while let Ok((path, identity)) = receiver.recv() {
					let _ = catch_unwind(AssertUnwindSafe(|| {
						let _ = exact_unlink_direct(path, identity);
					}));
				}
			})
			.is_ok();
		DetachedCleanupQueue { sender, worker_started }
	})
}

/// Restore only the detached object that still has the supplied exact
#[cfg_attr(clippy, doc = "")]
/// identity. The detached and original paths must retain the same validated
/// parent, and restoration never replaces an existing original path.
#[napi]
pub fn exact_restore(
	detached_path: String,
	original_path: String,
	identity: NativeExactFileIdentity,
) -> NativeExactUnlinkResult {
	if detached_path.contains('\0') || original_path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let Some(identity) = exact_file_identity(&identity) else {
		return NativeExactUnlinkResult::failure("identity_mismatch");
	};
	platform::exact_restore(Path::new(&detached_path), Path::new(&original_path), &identity)
}

#[napi]
pub fn rename_no_replace_path(
	source_path: String,
	destination_path: String,
) -> NativeNoReplaceResult {
	if source_path.contains('\0') || destination_path.contains('\0') {
		return NativeNoReplaceResult::from_exact(NativeExactUnlinkResult::failure(
			"invalid_request",
		));
	}
	NativeNoReplaceResult::from_exact(platform::rename_path_no_replace(
		Path::new(&source_path),
		Path::new(&destination_path),
	))
}

/// Publish a staged directory under a destination name that must not already
/// exist.
///
/// Uses descriptor-relative `mkdirat` ownership followed by `renameat`.
/// This is the directory stand-in for `renameat2(RENAME_NOREPLACE)` on mounts
/// that reject rename flags with `EINVAL`/`ENOSYS`. The native implementation
/// validates every path component without following symlinks and never
/// overwrites a non-empty destination directory.
#[napi]
pub fn rename_directory_no_replace_path(
	source_path: String,
	destination_path: String,
) -> NativeNoReplaceResult {
	if source_path.contains('\0') || destination_path.contains('\0') {
		return NativeNoReplaceResult::from_exact_with_primitive(
			NativeExactUnlinkResult::failure("invalid_request"),
			Some("mkdirat_renameat_noreplace"),
		);
	}
	NativeNoReplaceResult::from_exact_with_primitive(
		platform::rename_directory_path_no_replace(
			Path::new(&source_path),
			Path::new(&destination_path),
		),
		Some("mkdirat_renameat_noreplace"),
	)
}

/// Publish a staged regular file under a destination name that must not already
#[cfg_attr(clippy, doc = "")]
/// exist, using `linkat(2)` instead of a rename flag. This is the stand-in for
/// `rename_no_replace_path` on filesystems that implement no rename flag at all
/// (NFS answers `EINVAL`, pre-3.15 kernels `ENOSYS`), and it carries the same
/// no-overwrite guarantee because `linkat` fails with `EEXIST`.
///
/// The source name survives the call. Callers holding a descriptor on the
/// staged object must keep it across this publication and unlink the staging
/// name only after releasing it: NFS silly-renames a still-open name instead of
/// removing it, leaving a second link on the published inode.
#[napi]
pub fn link_no_replace_path(
	source_path: String,
	destination_path: String,
) -> NativeNoReplaceResult {
	if source_path.contains('\0') || destination_path.contains('\0') {
		return NativeNoReplaceResult::from_exact(NativeExactUnlinkResult::failure(
			"invalid_request",
		));
	}
	NativeNoReplaceResult::from_exact(platform::link_path_no_replace(
		Path::new(&source_path),
		Path::new(&destination_path),
	))
}

/// Create or overwrite one native skill's `SKILL.md` without following any
/// path component.
///
/// Every ancestor is opened descriptor/handle-relatively with
/// no-follow authority; the skill directory is created through the retained
/// skills-root authority, and content is written to a private retained file
/// before an atomic replacement of the final name. The publication verifies
/// identity and private permissions and synchronizes the affected namespace.
///
/// Unix and Windows targets implement the descriptor/handle-relative primitive.
/// Other platforms return `unsupported_platform` so callers cannot silently
/// fall back to a path-based write.
#[napi]
pub fn secure_write_skill_file(
	root_path: String,
	skill_name: String,
	content: String,
	file_mode: Option<u32>,
) -> NativeSecureSkillWriteResult {
	if root_path.contains('\0') || skill_name.contains('\0') || !Path::new(&root_path).is_absolute()
	{
		return NativeSecureSkillWriteResult::failure("invalid_request");
	}
	if skill_name.is_empty()
		|| skill_name == "."
		|| skill_name == ".."
		|| skill_name.contains('/')
		|| skill_name.contains('\\')
		|| !matches!(Path::new(&skill_name).components().next(), Some(Component::Normal(_)))
		|| Path::new(&skill_name).components().count() != 1
	{
		return NativeSecureSkillWriteResult::failure("invalid_request");
	}
	if Path::new(&root_path)
		.components()
		.any(|component| matches!(component, Component::ParentDir))
	{
		return NativeSecureSkillWriteResult::failure("invalid_request");
	}
	#[cfg(not(windows))]
	if Path::new(&root_path)
		.components()
		.any(|component| matches!(component, Component::Prefix(_)))
	{
		return NativeSecureSkillWriteResult::failure("invalid_request");
	}
	let file_mode = file_mode.unwrap_or(0o600);
	if !matches!(file_mode, 0o600 | 0o644) {
		return NativeSecureSkillWriteResult::failure("invalid_request");
	}
	platform::secure_write_skill_file(Path::new(&root_path), &skill_name, &content, file_mode)
}

/// Async variant of [`secure_write_skill_file`] scheduled on the libuv blocking
/// pool.
///
/// Directory traversal, ACL updates, payload writes, and flushes can all block
/// on a slow filesystem; none of that work may run on the JS thread.
#[napi]
pub fn secure_write_skill_file_async(
	root_path: String,
	skill_name: String,
	content: String,
	file_mode: Option<u32>,
) -> task::Promise<NativeSecureSkillWriteResult> {
	task::blocking("secure_write_skill_file", (), move |_| {
		Ok(secure_write_skill_file(root_path, skill_name, content, file_mode))
	})
}

/// Async variant of [`rename_no_replace_path`] scheduled on the libuv blocking
/// pool.
///
/// Managed output publication awaits this boundary so a rename that stalls in
/// the kernel (oversized APFS directory namespaces, issue #4394) blocks one
/// pool thread instead of the agent's event loop: await timeouts, sibling
/// subagents, and watchdogs keep running, and a hung publication degrades to
/// one unresolved receipt rather than a frozen process.
#[napi]
pub fn rename_no_replace_path_async(
	source_path: String,
	destination_path: String,
) -> task::Promise<NativeNoReplaceResult> {
	task::blocking("rename_no_replace_path", (), move |_| {
		Ok(rename_no_replace_path(source_path, destination_path))
	})
}

/// Async variant of [`rename_directory_no_replace_path`] scheduled on the
/// libuv blocking pool.
#[napi]
pub fn rename_directory_no_replace_path_async(
	source_path: String,
	destination_path: String,
) -> task::Promise<NativeNoReplaceResult> {
	task::blocking("rename_directory_no_replace_path", (), move |_| {
		Ok(rename_directory_no_replace_path(source_path, destination_path))
	})
}

/// Async variant of [`link_no_replace_path`] scheduled on the libuv blocking
/// pool; see [`rename_no_replace_path_async`] for the rationale.
#[napi]
pub fn link_no_replace_path_async(
	source_path: String,
	destination_path: String,
) -> task::Promise<NativeNoReplaceResult> {
	task::blocking("link_no_replace_path", (), move |_| {
		Ok(link_no_replace_path(source_path, destination_path))
	})
}

/// Capture a deterministic, descriptor-relative snapshot of a regular-file and
/// directory-only tree. Symlinks, special files, non-UTF-8 names, and topology
/// changes are rejected rather than followed.
#[napi]
pub fn snapshot_directory_tree(path: String) -> NativeDirectoryTreeResult {
	if path.contains('\0') {
		return NativeDirectoryTreeResult::failure("io_error");
	}
	platform::snapshot_directory_tree(Path::new(&path))
}

/// Remove a directory tree only when a fresh descriptor-relative snapshot
#[cfg_attr(clippy, doc = "")]
/// exactly equals the persisted snapshot. POSIX first no-replace detaches the
/// verified root to its deterministic `.removing` sibling; the reopened
/// detached descriptor remains authoritative throughout payload scrubbing and
/// replay.
#[napi]
pub fn exact_remove_directory_tree(
	path: String,
	snapshot: NativeDirectoryTreeSnapshot,
	parent_identity: Option<NativeDirectoryParentIdentity>,
) -> NativeExactUnlinkResult {
	if path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	let parent_identity = match parent_identity {
		Some(identity) => {
			let (dev_negative, dev, dev_lossless) = identity.dev.get_u64();
			let (ino_negative, ino, ino_lossless) = identity.ino.get_u64();
			if dev_negative || ino_negative || !dev_lossless || !ino_lossless {
				return NativeExactUnlinkResult::failure("identity_mismatch");
			}
			Some((dev, ino))
		},
		None => None,
	};
	platform::exact_remove_directory_tree(Path::new(&path), &snapshot, parent_identity)
}

#[cfg(unix)]
fn path_from_bytes(bytes: &[u8]) -> PathBuf {
	use std::os::unix::ffi::OsStringExt;

	PathBuf::from(std::ffi::OsString::from_vec(bytes.to_vec()))
}

#[cfg(not(unix))]
fn path_from_bytes(bytes: &[u8]) -> Option<PathBuf> {
	String::from_utf8(bytes.to_vec()).ok().map(PathBuf::from)
}

#[cfg(unix)]
mod publication {
	use std::{
		fs::File,
		io::Read,
		os::unix::fs::{FileExt, MetadataExt},
		path::{Path, PathBuf},
	};

	#[cfg(target_vendor = "apple")]
	const fn mode_kind(kind: libc::mode_t) -> u32 {
		kind as u32
	}

	#[cfg(not(target_vendor = "apple"))]
	const fn mode_kind(kind: libc::mode_t) -> u32 {
		kind
	}

	struct Identity {
		dev: u64,
		ino: u64,
	}

	#[derive(Debug)]
	pub(super) struct RetainedPublicationOpenFailure {
		pub(super) object: &'static str,
		pub(super) reason: String,
	}

	impl Identity {
		fn of(file: &File) -> Option<Self> {
			let metadata = file.metadata().ok()?;
			Some(Self { dev: metadata.dev(), ino: metadata.ino() })
		}

		fn matches(&self, file: &File, expected_kind: u32) -> bool {
			file.metadata().is_ok_and(|metadata| {
				metadata.dev() == self.dev
					&& metadata.ino() == self.ino
					&& metadata.mode() & mode_kind(libc::S_IFMT) == expected_kind
			})
		}
	}

	fn open_result(path: &Path, directory: bool, write: bool) -> std::io::Result<File> {
		use std::os::fd::FromRawFd;
		let bytes = std::os::unix::ffi::OsStrExt::as_bytes(path.as_os_str());
		let name = std::ffi::CString::new(bytes)
			.map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "path contains NUL"))?;
		let flags = (if write { libc::O_RDWR } else { libc::O_RDONLY })
			| libc::O_CLOEXEC
			| libc::O_NOFOLLOW
			| libc::O_NONBLOCK
			| if directory { libc::O_DIRECTORY } else { 0 };
		// SAFETY: `name` is a live NUL-terminated path and `flags` contains only
		// valid open(2) flags. A non-negative descriptor is uniquely transferred
		// into `File` exactly once below.
		let fd = unsafe { libc::open(name.as_ptr(), flags) };
		if fd < 0 {
			return Err(std::io::Error::last_os_error());
		}
		// SAFETY: successful open(2) returned an owned descriptor that has not
		// been wrapped or closed elsewhere.
		Ok(unsafe { File::from_raw_fd(fd) })
	}

	fn open(
		path: &Path,
		object: &'static str,
		directory: bool,
		write: bool,
	) -> Result<File, RetainedPublicationOpenFailure> {
		open_result(path, directory, write).map_err(|error| RetainedPublicationOpenFailure {
			object,
			reason: error.raw_os_error().map_or_else(
				|| format!("io-{}", error.kind()),
				|code| format!("errno-{}", errno_name(code)),
			),
		})
	}

	/// Closed errno vocabulary for the acquisition diagnostic. Only fixed
	/// labels leave the native layer, and every errno `open(2)` can answer
	/// these objects with is named: an unnamed one would surface as `UNKNOWN`
	/// and lose the actionable part of the diagnostic this failure carries.
	pub(super) const fn errno_name(errno: i32) -> &'static str {
		match errno {
			libc::EACCES => "EACCES",
			libc::EAGAIN => "EAGAIN",
			libc::EISDIR => "EISDIR",
			libc::ELOOP => "ELOOP",
			libc::EMFILE => "EMFILE",
			libc::ENAMETOOLONG => "ENAMETOOLONG",
			libc::ENFILE => "ENFILE",
			libc::ENOENT => "ENOENT",
			libc::ENOMEM => "ENOMEM",
			libc::ENOTDIR => "ENOTDIR",
			libc::ENXIO => "ENXIO",
			libc::EOVERFLOW => "EOVERFLOW",
			libc::EPERM => "EPERM",
			_ => "UNKNOWN",
		}
	}

	fn failure(object: &'static str, reason: impl Into<String>) -> RetainedPublicationOpenFailure {
		RetainedPublicationOpenFailure { object, reason: reason.into() }
	}

	pub(super) struct RetainedPublication {
		// Declaration order is drop order: release publication authority first.
		discovery:          File,
		_owner:             File,
		_lock:              File,
		_root:              File,
		root_identity:      Identity,
		lock_identity:      Identity,
		owner_identity:     Identity,
		discovery_identity: Identity,
		heartbeat_offset:   u64,
		agent_dir:          PathBuf,
	}

	impl RetainedPublication {
		pub(super) fn open(agent_dir: &Path) -> Result<Self, RetainedPublicationOpenFailure> {
			let root = open(&agent_dir.join("sdk"), "sdk", true, false)?;
			let lock = open(&agent_dir.join("sdk/broker.lock"), "sdk/broker.lock", true, false)?;
			let owner = open(
				&agent_dir.join("sdk/broker.lock/owner.json"),
				"sdk/broker.lock/owner.json",
				false,
				false,
			)?;
			if owner
				.metadata()
				.map_err(|error| {
					failure("sdk/broker.lock/owner.json", format!("metadata-{}", error.kind()))
				})?
				.mode() & mode_kind(libc::S_IFMT)
				!= mode_kind(libc::S_IFREG)
			{
				return Err(failure("sdk/broker.lock/owner.json", "non-regular"));
			}
			let discovery = open(&agent_dir.join("sdk/broker.json"), "sdk/broker.json", false, true)?;
			let mut readable = discovery
				.try_clone()
				.map_err(|error| failure("sdk/broker.json", format!("clone-{}", error.kind())))?;
			let mut bytes = Vec::new();
			readable
				.read_to_end(&mut bytes)
				.map_err(|error| failure("sdk/broker.json", format!("read-{}", error.kind())))?;
			let needle = b"\"heartbeatAt\":";
			let start = bytes
				.windows(needle.len())
				.position(|window| window == needle)
				.ok_or_else(|| failure("sdk/broker.json", "heartbeat-missing"))?
				+ needle.len();
			let digits = bytes
				.get(start..start + 13)
				.ok_or_else(|| failure("sdk/broker.json", "heartbeat-width"))?;
			if digits.iter().any(|byte| !byte.is_ascii_digit())
				|| bytes.get(start + 13).is_some_and(u8::is_ascii_digit)
			{
				return Err(failure("sdk/broker.json", "heartbeat-width"));
			}
			Ok(Self {
				root_identity: Identity::of(&root).ok_or_else(|| failure("sdk", "metadata"))?,
				lock_identity: Identity::of(&lock)
					.ok_or_else(|| failure("sdk/broker.lock", "metadata"))?,
				owner_identity: Identity::of(&owner)
					.ok_or_else(|| failure("sdk/broker.lock/owner.json", "metadata"))?,
				discovery_identity: Identity::of(&discovery)
					.ok_or_else(|| failure("sdk/broker.json", "metadata"))?,
				agent_dir: agent_dir.to_path_buf(),
				_root: root,
				_lock: lock,
				_owner: owner,
				discovery,
				heartbeat_offset: start as u64,
			})
		}

		pub(super) fn observe(&self) -> String {
			fn named(path: &Path, identity: &Identity, directory: bool) -> &'static str {
				match open_result(path, directory, false) {
					Ok(file)
						if identity.matches(
							&file,
							if directory {
								mode_kind(libc::S_IFDIR)
							} else {
								mode_kind(libc::S_IFREG)
							},
						) =>
					{
						"owned"
					},
					Ok(_) => "replaced",
					Err(error) => match error.raw_os_error() {
						Some(libc::ENOENT) => "absent",
						Some(libc::ELOOP | libc::ENOTDIR) => "replaced",
						_ => "ambiguous",
					},
				}
			}
			let checks = [
				named(&self.agent_dir.join("sdk"), &self.root_identity, true),
				named(&self.agent_dir.join("sdk/broker.lock"), &self.lock_identity, true),
				named(&self.agent_dir.join("sdk/broker.lock/owner.json"), &self.owner_identity, false),
				named(&self.agent_dir.join("sdk/broker.json"), &self.discovery_identity, false),
			];
			if checks.iter().all(|kind| *kind == "owned") {
				"owned".to_owned()
			} else if checks.contains(&"replaced") {
				"replaced".to_owned()
			} else if checks.contains(&"absent") {
				"absent".to_owned()
			} else {
				"ambiguous".to_owned()
			}
		}

		pub(super) fn heartbeat(&self, heartbeat_at: &str) -> String {
			if heartbeat_at.len() != 13 || !heartbeat_at.bytes().all(|byte| byte.is_ascii_digit()) {
				return "ambiguous".to_owned();
			}
			match self
				.discovery
				.write_at(heartbeat_at.as_bytes(), self.heartbeat_offset)
			{
				Ok(13) => "written".to_owned(),
				_ => "ambiguous".to_owned(),
			}
		}

		pub(super) fn sync(&self) -> String {
			if self.discovery.sync_all().is_ok() {
				"synced".to_owned()
			} else {
				"ambiguous".to_owned()
			}
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::publication::errno_name;

	#[test]
	fn errno_name_covers_every_open_refusal_the_diagnostic_can_report() {
		for (errno, name) in [
			(libc::EACCES, "EACCES"),
			(libc::EAGAIN, "EAGAIN"),
			(libc::EISDIR, "EISDIR"),
			(libc::ELOOP, "ELOOP"),
			(libc::EMFILE, "EMFILE"),
			(libc::ENAMETOOLONG, "ENAMETOOLONG"),
			(libc::ENFILE, "ENFILE"),
			(libc::ENOENT, "ENOENT"),
			(libc::ENOMEM, "ENOMEM"),
			(libc::ENOTDIR, "ENOTDIR"),
			(libc::ENXIO, "ENXIO"),
			(libc::EOVERFLOW, "EOVERFLOW"),
			(libc::EPERM, "EPERM"),
		] {
			assert_eq!(errno_name(errno), name, "errno {errno} must keep its fixed label");
		}
	}

	#[test]
	fn errno_name_keeps_an_unlisted_errno_inside_the_closed_vocabulary() {
		assert_eq!(errno_name(0), "UNKNOWN");
		assert_eq!(errno_name(-1), "UNKNOWN");
	}
}

#[cfg(not(unix))]
mod publication {
	use std::path::Path;

	#[derive(Debug)]
	pub(super) struct RetainedPublicationOpenFailure {
		pub(super) object: &'static str,
		pub(super) reason: String,
	}

	/// Windows retained HANDLE/FileIdInfo authority is intentionally unavailable
	/// until its reparse-safe implementation lands; acquisition fails closed.
	pub(super) struct RetainedPublication;
	impl RetainedPublication {
		pub(super) fn open(_: &Path) -> Result<Self, RetainedPublicationOpenFailure> {
			Err(RetainedPublicationOpenFailure {
				object: "sdk",
				reason: "unsupported-platform".to_owned(),
			})
		}

		pub(super) fn observe(&self) -> String {
			"ambiguous".to_owned()
		}

		pub(super) fn heartbeat(&self, _: &str) -> String {
			"ambiguous".to_owned()
		}

		pub(super) fn sync(&self) -> String {
			"ambiguous".to_owned()
		}
	}

	#[cfg(test)]
	mod tests {
		use std::path::Path;

		use super::RetainedPublication;

		#[test]
		fn retained_publication_reports_structured_unsupported_platform_failure() {
			let failure = match RetainedPublication::open(Path::new("sdk")) {
				Ok(_) => panic!("Windows retention is unavailable"),
				Err(failure) => failure,
			};
			assert_eq!(failure.object, "sdk");
			assert_eq!(failure.reason, "unsupported-platform");
		}
	}
}
#[cfg(unix)]
pub(crate) mod platform {
	#[cfg(target_os = "linux")]
	use std::os::unix::fs::MetadataExt;
	#[cfg(test)]
	use std::sync::atomic::AtomicBool;
	#[cfg(test)]
	use std::sync::{Mutex, OnceLock, mpsc};
	use std::{
		borrow::Cow,
		ffi::CString,
		fmt::Write as _,
		fs::{self, File},
		io::{Read as IoRead, Write as IoWrite},
		os::{
			fd::{AsRawFd, FromRawFd, IntoRawFd},
			unix::ffi::OsStrExt,
		},
		path::{Component, Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeEntry,
		NativeDirectoryTreeResult, NativeDirectoryTreeSnapshot, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, NativeSecureSkillWriteResult, digest_reader, io_code,
		security_io_code, sha256,
	};

	/// Bound on EINTR restarts for the no-replace rename primitive. A signal
	/// arriving mid-syscall leaves no filesystem side effect (the syscall never
	/// committed), so restarting is always safe; the bound only guards against a
	/// pathological signal storm turning a retry loop into a hang.
	const EINTR_RETRY_LIMIT: u32 = 8;

	// Test-only fault injection: the next N calls into the no-replace rename
	// primitive report a synthetic EINTR before the real syscall runs, letting
	// tests exercise the restart loop without racing a real signal.
	#[cfg(test)]
	thread_local! {
		static RENAME_NO_REPLACE_EINTR_INJECT: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
	}

	#[cfg(test)]
	thread_local! {
		static ROOT_PARENT_FSYNC_FAIL_ON_CALL: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
	}
	#[cfg(test)]
	thread_local! {
		static RENAME_EXCHANGE_FAIL_ON_CALL: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
	}

	#[cfg(test)]
	pub(super) fn inject_root_parent_fsync_failure(call: u32) {
		ROOT_PARENT_FSYNC_FAIL_ON_CALL.with(|target| target.set(call));
	}

	#[cfg(test)]
	fn take_injected_root_parent_fsync_failure() -> bool {
		ROOT_PARENT_FSYNC_FAIL_ON_CALL.with(|target| {
			let current = target.get();
			if current == 0 {
				return false;
			}
			target.set(current - 1);
			current == 1
		})
	}

	#[cfg(not(test))]
	const fn take_injected_root_parent_fsync_failure() -> bool {
		false
	}
	#[cfg(test)]
	pub(super) fn inject_rename_exchange_failure(call: u32) {
		RENAME_EXCHANGE_FAIL_ON_CALL.with(|target| target.set(call));
	}

	#[cfg(test)]
	fn take_injected_rename_exchange_failure() -> bool {
		RENAME_EXCHANGE_FAIL_ON_CALL.with(|target| {
			let current = target.get();
			if current == 0 {
				return false;
			}
			target.set(current - 1);
			current == 1
		})
	}

	#[cfg(not(test))]
	const fn take_injected_rename_exchange_failure() -> bool {
		false
	}

	fn fsync_root_parent(fd: libc::c_int) -> Result<(), &'static str> {
		if take_injected_root_parent_fsync_failure() {
			return Err("io_error");
		}
		// SAFETY: `fd` is a live retained parent directory descriptor.
		if unsafe { libc::fsync(fd) } != 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		Ok(())
	}

	#[cfg(test)]
	pub(super) fn inject_rename_no_replace_eintr(count: u32) {
		RENAME_NO_REPLACE_EINTR_INJECT.with(|remaining| remaining.set(count));
	}

	#[cfg(test)]
	fn take_injected_rename_no_replace_eintr() -> bool {
		RENAME_NO_REPLACE_EINTR_INJECT.with(|remaining| {
			let current = remaining.get();
			if current == 0 {
				return false;
			}
			remaining.set(current - 1);
			true
		})
	}

	#[cfg(not(test))]
	const fn take_injected_rename_no_replace_eintr() -> bool {
		false
	}

	#[cfg(test)]
	static EXACT_REPLACE_AFTER_EXCHANGE_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();

	#[cfg(test)]
	static EXACT_REPLACE_BEFORE_FINAL_VERIFY_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();

	#[cfg(test)]
	static AFTER_EXCHANGE_HOOK: OnceLock<Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>> =
		OnceLock::new();

	#[cfg(test)]
	static BEFORE_EXCHANGE_HOOK: OnceLock<Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>> =
		OnceLock::new();

	#[cfg(test)]
	static AFTER_PLACEHOLDER_DETACH_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static AFTER_TREE_VALIDATION_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static BEFORE_TREE_ROOT_RENAME_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static AFTER_TREE_SCRUB_HOOK: OnceLock<Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>> =
		OnceLock::new();

	#[cfg(test)]
	static BEFORE_TREE_CHILD_RENAME_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();

	#[cfg(test)]
	static AFTER_TREE_FILE_LINK_CHECK_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static FAIL_SECURE_SKILL_CLEANUP: AtomicBool = AtomicBool::new(false);

	static NEXT_SECURE_SKILL_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	#[cfg(test)]
	pub(super) fn set_exact_replace_after_exchange_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*EXACT_REPLACE_AFTER_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn set_exact_replace_before_final_verify_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*EXACT_REPLACE_BEFORE_FINAL_VERIFY_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_after_exchange_hook(hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>) {
		*AFTER_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn set_before_exchange_hook(hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>) {
		*BEFORE_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_after_placeholder_detach_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*AFTER_PLACEHOLDER_DETACH_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_after_tree_validation_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*AFTER_TREE_VALIDATION_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_before_tree_root_rename_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*BEFORE_TREE_ROOT_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_after_tree_scrub_hook(hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>) {
		*AFTER_TREE_SCRUB_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_before_tree_child_rename_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*BEFORE_TREE_CHILD_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(all(test, target_os = "linux"))]
	pub(super) fn set_after_tree_file_link_check_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*AFTER_TREE_FILE_LINK_CHECK_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn set_secure_skill_write_before_rename_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn inject_secure_skill_cleanup_failure(enabled: bool) {
		FAIL_SECURE_SKILL_CLEANUP.store(enabled, Ordering::Relaxed);
	}

	#[cfg(test)]
	fn pause_exact_replace_after_exchange_for_test() {
		if let Some((entered, resume)) = EXACT_REPLACE_AFTER_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered
				.send(())
				.expect("exact replace exchange hook receiver");
			resume.recv().expect("exact replace exchange hook resume");
		}
	}

	#[cfg(test)]
	fn pause_exact_replace_before_final_verify_for_test() {
		if let Some((entered, resume)) = EXACT_REPLACE_BEFORE_FINAL_VERIFY_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered
				.send(())
				.expect("exact replace final verify hook receiver");
			resume
				.recv()
				.expect("exact replace final verify hook resume");
		}
	}

	#[cfg(test)]
	fn pause_after_exchange_for_test() {
		if let Some((entered, resume)) = AFTER_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("exchange hook receiver");
			resume.recv().expect("exchange hook resume");
		}
	}

	#[cfg(test)]
	fn pause_before_exchange_for_test() {
		if let Some((entered, resume)) = BEFORE_EXCHANGE_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("before exchange hook receiver");
			resume.recv().expect("before exchange hook resume");
		}
	}

	#[cfg(test)]
	fn pause_after_placeholder_detach_for_test() {
		if let Some((entered, resume)) = AFTER_PLACEHOLDER_DETACH_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("placeholder detach hook receiver");
			resume.recv().expect("placeholder detach hook resume");
		}
	}

	#[cfg(test)]
	fn pause_after_tree_validation_for_test() {
		if let Some((entered, resume)) = AFTER_TREE_VALIDATION_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("tree validation hook receiver");
			resume.recv().expect("tree validation hook resume");
		}
	}

	#[cfg(test)]
	fn pause_before_tree_root_rename_for_test() {
		if let Some((entered, resume)) = BEFORE_TREE_ROOT_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("tree root rename hook receiver");
			resume.recv().expect("tree root rename hook resume");
		}
	}

	#[cfg(test)]
	fn pause_after_tree_scrub_for_test() {
		if let Some((entered, resume)) = AFTER_TREE_SCRUB_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("tree scrub hook receiver");
			resume.recv().expect("tree scrub hook resume");
		}
	}

	#[cfg(test)]
	fn pause_before_tree_child_rename_for_test() {
		if let Some((entered, resume)) = BEFORE_TREE_CHILD_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("tree child rename hook receiver");
			resume.recv().expect("tree child rename hook resume");
		}
	}

	#[cfg(test)]
	fn pause_after_tree_file_link_check_for_test() {
		if let Some((entered, resume)) = AFTER_TREE_FILE_LINK_CHECK_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("tree file mutation hook receiver");
			resume.recv().expect("tree file mutation hook resume");
		}
	}

	#[cfg(test)]
	fn pause_secure_skill_write_before_rename_for_test() {
		if let Some((entered, resume)) = SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("secure skill write hook receiver");
			resume.recv().expect("secure skill write hook resume");
		}
	}

	pub(super) fn canonical_existing_directory_identity(
		path: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		let canonical = match fs::canonicalize(path) {
			Ok(path) => path,
			Err(error) => return NativeCanonicalDirectoryIdentity::failure(io_code(&error)),
		};
		let metadata = match fs::metadata(&canonical) {
			Ok(metadata) => metadata,
			Err(error) => return NativeCanonicalDirectoryIdentity::failure(io_code(&error)),
		};
		if !metadata.is_dir() {
			return NativeCanonicalDirectoryIdentity::failure("not_directory");
		}
		let Some(canonical_path) = canonical.as_os_str().to_str() else {
			return NativeCanonicalDirectoryIdentity::failure("not_utf8");
		};
		NativeCanonicalDirectoryIdentity::success("posix", canonical_path.to_owned())
	}

	fn security_code(error: &std::io::Error) -> &'static str {
		if error.raw_os_error() == Some(libc::ELOOP) {
			"reparse_point"
		} else {
			security_io_code(error)
		}
	}

	#[cfg(target_os = "netbsd")]
	fn stat_mtime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtimensec)
	}

	#[cfg(not(target_os = "netbsd"))]
	fn stat_mtime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_mtime) * 1_000_000_000 + i128::from(stat.st_mtime_nsec)
	}

	#[cfg(target_os = "netbsd")]
	fn stat_ctime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_ctime) * 1_000_000_000 + i128::from(stat.st_ctimensec)
	}

	#[cfg(not(target_os = "netbsd"))]
	fn stat_ctime_ns(stat: &libc::stat) -> i128 {
		i128::from(stat.st_ctime) * 1_000_000_000 + i128::from(stat.st_ctime_nsec)
	}

	struct AuthorityEdge {
		parent:         File,
		parent_initial: libc::stat,
		name:           CString,
		child:          File,
		child_initial:  libc::stat,
	}

	struct CheckedPathAuthority {
		file:           File,
		parent:         File,
		parent_initial: libc::stat,
		name:           CString,
		initial:        libc::stat,
		edges:          Vec<AuthorityEdge>,
	}

	const fn stat_same_object(left: &libc::stat, right: &libc::stat) -> bool {
		left.st_dev == right.st_dev
			&& left.st_ino == right.st_ino
			&& left.st_uid == right.st_uid
			&& left.st_mode & libc::S_IFMT == right.st_mode & libc::S_IFMT
	}

	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn fstat(fd: libc::c_int) -> Result<libc::stat, NativeOwnerOnlySecurityResult> {
		// SAFETY: libc::stat is a plain C data structure that may be zero-initialized
		// before fstat fills it.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: fd is caller-retained for this operation and stat points to writable
		// initialized storage.
		if unsafe { libc::fstat(fd, &mut stat) } != 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		Ok(stat)
	}

	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn duplicate_cloexec(fd: libc::c_int) -> Result<File, NativeOwnerOnlySecurityResult> {
		// SAFETY: fcntl only reads the supplied live descriptor and returns a new
		// CLOEXEC descriptor.
		let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
		if duplicate < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		// SAFETY: duplicate is a newly owned descriptor returned by F_DUPFD_CLOEXEC.
		Ok(unsafe { File::from_raw_fd(duplicate) })
	}

	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn statat(parent: &File, name: &CString) -> Result<libc::stat, NativeOwnerOnlySecurityResult> {
		// SAFETY: libc::stat is a plain C data structure that fstatat fully initializes
		// on success.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: parent is a live directory descriptor, name is NUL-terminated, and
		// named is writable.
		if unsafe {
			libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
		} != 0
		{
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
			return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
		}
		Ok(named)
	}

	#[allow(
		clippy::missing_const_for_fn,
		reason = "the macOS alias branch constructs a canonical owned path"
	)]
	fn descriptor_walk_path(path: &Path) -> Cow<'_, Path> {
		#[cfg(target_os = "macos")]
		{
			for alias in ["/var", "/tmp", "/etc"] {
				if let Ok(suffix) = path.strip_prefix(alias) {
					return Cow::Owned(Path::new("/private").join(&alias[1..]).join(suffix));
				}
			}
		}
		Cow::Borrowed(path)
	}

	/// Open each component through retained directory descriptors. Every name is
	/// lstat'd and then opened no-follow; the two identities must agree. `..`
	/// is never accepted, so a pathname cannot escape the authority selected at
	/// the start of this operation.
	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn checked_file(
		path: &Path,
		kind: &str,
	) -> Result<CheckedPathAuthority, NativeOwnerOnlySecurityResult> {
		if !matches!(kind, "directory" | "file") {
			return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
		}
		let walk_path = descriptor_walk_path(path);
		let base = if walk_path.is_absolute() {
			b"/\0"
		} else {
			b".\0"
		};
		// SAFETY: base is a static NUL-terminated path and the flags request a
		// no-follow directory descriptor.
		let fd = unsafe {
			libc::open(
				base.as_ptr().cast(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if fd < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		// SAFETY: fd is a newly owned successful open result.
		let mut current = unsafe { File::from_raw_fd(fd) };
		let mut edges = Vec::new();
		let mut segments = Vec::new();
		for component in walk_path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
				},
			}
		}
		let (final_name, parent_segments): (Vec<u8>, &[Vec<u8>]) = match segments.split_last() {
			Some((name, parents)) => (name.clone(), parents),
			None if kind == "directory" => (b".".to_vec(), &[]),
			None => return Err(NativeOwnerOnlySecurityResult::failure("not_directory")),
		};
		for segment in parent_segments {
			let name = CString::new(segment.as_slice())
				.map_err(|_| NativeOwnerOnlySecurityResult::failure("io_error"))?;
			let named = statat(&current, &name)?;
			// SAFETY: current is a live directory descriptor and name is a validated
			// NUL-terminated component.
			let next_fd = unsafe {
				libc::openat(
					current.as_raw_fd(),
					name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			if next_fd < 0 {
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
			// SAFETY: next_fd is a newly owned successful openat result.
			let child = unsafe { File::from_raw_fd(next_fd) };
			let child_initial = fstat(child.as_raw_fd())?;
			if !stat_same_object(&named, &child_initial) {
				return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
			}
			let next = duplicate_cloexec(child.as_raw_fd())?;
			let parent_initial = fstat(current.as_raw_fd())?;
			edges.push(AuthorityEdge { parent: current, parent_initial, name, child, child_initial });
			current = next;
		}
		let name = CString::new(final_name)
			.map_err(|_| NativeOwnerOnlySecurityResult::failure("io_error"))?;
		let named = statat(&current, &name)?;
		let expected_kind = if kind == "directory" {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		let is_directory = named.st_mode & libc::S_IFMT == libc::S_IFDIR;
		if named.st_mode & libc::S_IFMT != expected_kind {
			return Err(NativeOwnerOnlySecurityResult::failure("not_directory"));
		}
		let mut flags = libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_RDONLY;
		if is_directory {
			flags |= libc::O_DIRECTORY;
		} else {
			flags |= libc::O_NONBLOCK;
		}
		// SAFETY: current is retained, name is validated and NUL-terminated, and
		// O_NOFOLLOW rejects symlinks.
		let target_fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags) };
		#[cfg(target_os = "macos")]
		let target_fd = if target_fd < 0 && !is_directory {
			let read_error = std::io::Error::last_os_error();
			if read_error.raw_os_error() == Some(libc::EACCES) {
				// A hostile macOS ACL may deny reads while leaving owner writes
				// available. Retry only that denial with write authority so ACLs can
				// be inspected and repaired without changing file contents.
				// SAFETY: this retries the same retained parent and validated final component.
				unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), flags | libc::O_WRONLY) }
			} else {
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(&read_error)));
			}
		} else {
			target_fd
		};
		if target_fd < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		// SAFETY: target_fd is a newly owned successful openat result.
		let file = unsafe { File::from_raw_fd(target_fd) };
		let initial = fstat(file.as_raw_fd())?;
		if !stat_same_object(&named, &initial) {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
		}
		if initial.st_mode & libc::S_IFMT != expected_kind {
			return Err(NativeOwnerOnlySecurityResult::failure("not_directory"));
		}
		let parent_initial = fstat(current.as_raw_fd())?;
		Ok(CheckedPathAuthority { file, parent: current, parent_initial, name, initial, edges })
	}

	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn revalidate_authority(
		authority: &CheckedPathAuthority,
	) -> Result<libc::stat, NativeOwnerOnlySecurityResult> {
		for edge in &authority.edges {
			let parent = fstat(edge.parent.as_raw_fd())?;
			let child = fstat(edge.child.as_raw_fd())?;
			let named = statat(&edge.parent, &edge.name)?;
			if !stat_same_object(&edge.parent_initial, &parent)
				|| !stat_same_object(&edge.child_initial, &child)
				|| !stat_same_object(&edge.child_initial, &named)
			{
				return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
			}
		}
		let parent = fstat(authority.parent.as_raw_fd())?;
		let actual = fstat(authority.file.as_raw_fd())?;
		let named = statat(&authority.parent, &authority.name)?;
		if !stat_same_object(&authority.parent_initial, &parent)
			|| !stat_same_object(&authority.initial, &actual)
			|| !stat_same_object(&authority.initial, &named)
		{
			return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
		}
		Ok(actual)
	}

	#[cfg(target_os = "linux")]
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	enum AclAttribute {
		Access,
		Default,
	}

	#[cfg(target_os = "linux")]
	impl AclAttribute {
		const fn name(self) -> &'static [u8] {
			match self {
				Self::Access => b"system.posix_acl_access\0",
				Self::Default => b"system.posix_acl_default\0",
			}
		}
	}

	#[cfg(target_os = "linux")]
	const fn acl_attribute_name(attribute: AclAttribute) -> &'static str {
		match attribute {
			AclAttribute::Access => "access",
			AclAttribute::Default => "default",
		}
	}

	#[cfg(target_os = "linux")]
	const fn acl_operation_name(operation: AclOperation) -> &'static str {
		match operation {
			AclOperation::Clear => "clear",
			AclOperation::Query => "query",
		}
	}

	#[cfg(target_os = "linux")]
	fn acl_observation_failure(
		operation: AclOperation,
		attribute: AclAttribute,
		code: &'static str,
	) -> NativeOwnerOnlySecurityResult {
		let category = if code.ends_with("_denied") {
			"denied"
		} else if code.ends_with("_io") {
			"io_error"
		} else if code.ends_with("_errno_missing") {
			"errno_missing"
		} else if code.ends_with("_unknown") {
			"unknown"
		} else if code.ends_with("_malformed") {
			"malformed"
		} else if code.ends_with("_present") {
			"present"
		} else {
			"impossible"
		};
		NativeOwnerOnlySecurityResult::acl_failure(
			acl_operation_name(operation),
			acl_attribute_name(attribute),
			category,
		)
	}
	#[cfg(target_os = "linux")]
	#[derive(Clone, Copy)]
	enum AclOperation {
		Clear,
		Query,
	}

	#[cfg(target_os = "linux")]
	#[derive(Debug, PartialEq, Eq)]
	enum AclObservation {
		Cleared,
		Absent,
		UnsupportedRequiresQuery,
		Unsupported,
		Present,
		Failure(&'static str),
	}

	#[cfg(target_os = "linux")]
	const fn classify_acl_observation(
		operation: AclOperation,
		attribute: AclAttribute,
		result: libc::ssize_t,
		errno: Option<i32>,
	) -> AclObservation {
		match (operation, result) {
			(AclOperation::Clear, 0) => AclObservation::Cleared,
			(AclOperation::Query, result) if result > 0 => AclObservation::Present,
			(AclOperation::Clear | AclOperation::Query, -1) => match errno {
				Some(libc::ENODATA) => AclObservation::Absent,
				Some(errno) if errno == libc::EOPNOTSUPP || errno == libc::ENOTSUP => match operation {
					AclOperation::Clear => AclObservation::UnsupportedRequiresQuery,
					AclOperation::Query => AclObservation::Unsupported,
				},
				Some(libc::EACCES | libc::EPERM) => AclObservation::Failure(match operation {
					AclOperation::Clear => "acl_clear_denied",
					AclOperation::Query => "acl_query_denied",
				}),
				Some(libc::EIO) => AclObservation::Failure(match operation {
					AclOperation::Clear => "acl_clear_io",
					AclOperation::Query => "acl_query_io",
				}),
				None => AclObservation::Failure(match operation {
					AclOperation::Clear => "acl_clear_errno_missing",
					AclOperation::Query => "acl_query_errno_missing",
				}),
				Some(_) => AclObservation::Failure(match (operation, attribute) {
					(AclOperation::Clear, AclAttribute::Default) => "acl_default_clear_unknown",
					(AclOperation::Query, AclAttribute::Default) => "acl_default_query_unknown",
					(AclOperation::Clear, AclAttribute::Access) => "acl_clear_unknown",
					(AclOperation::Query, AclAttribute::Access) => "acl_query_unknown",
				}),
			},
			(AclOperation::Clear, _) => AclObservation::Failure("acl_clear_impossible"),
			(AclOperation::Query, 0) => AclObservation::Failure(match attribute {
				AclAttribute::Access => "acl_access_malformed",
				AclAttribute::Default => "acl_default_malformed",
			}),
			(AclOperation::Query, _) => AclObservation::Failure("acl_query_impossible"),
		}
	}

	#[cfg(target_os = "linux")]
	#[allow(clippy::result_large_err, reason = "preserves operation-specific ACL failure evidence")]
	fn clear_extended_acl(
		file: &File,
		attribute: AclAttribute,
	) -> Result<&'static str, NativeOwnerOnlySecurityResult> {
		// SAFETY: file is a live descriptor and attribute.name() is a static
		// NUL-terminated xattr name.
		let result =
			unsafe { libc::fremovexattr(file.as_raw_fd(), attribute.name().as_ptr().cast()) };
		let errno = if result == 0 {
			None
		} else {
			std::io::Error::last_os_error().raw_os_error()
		}; // capture immediately after this failed syscall
		match classify_acl_observation(AclOperation::Clear, attribute, result as libc::ssize_t, errno)
		{
			AclObservation::Cleared => Ok("cleared"),
			AclObservation::Absent => Ok("already_absent"),
			AclObservation::UnsupportedRequiresQuery => Ok("unsupported"),
			AclObservation::Failure(code) => {
				Err(acl_observation_failure(AclOperation::Clear, attribute, code))
			},
			AclObservation::Present | AclObservation::Unsupported => {
				Err(acl_observation_failure(AclOperation::Clear, attribute, "acl_clear_impossible"))
			},
		}
	}

	#[cfg(target_os = "linux")]
	#[allow(clippy::result_large_err, reason = "preserves operation-specific ACL failure evidence")]
	fn query_extended_acl(
		file: &File,
		attribute: AclAttribute,
	) -> Result<&'static str, NativeOwnerOnlySecurityResult> {
		// SAFETY: file is live, the xattr name is NUL-terminated, and a null
		// zero-length buffer is a size query.
		let result = unsafe {
			libc::fgetxattr(
				file.as_raw_fd(),
				attribute.name().as_ptr().cast(),
				std::ptr::null_mut(),
				0,
			)
		};
		let errno = if result >= 0 {
			None
		} else {
			std::io::Error::last_os_error().raw_os_error()
		}; // capture immediately after this failed syscall
		match classify_acl_observation(AclOperation::Query, attribute, result, errno) {
			AclObservation::Absent => Ok("absent"),
			AclObservation::Unsupported => Ok("unsupported"),
			AclObservation::Present => {
				Err(acl_observation_failure(AclOperation::Query, attribute, match attribute {
					AclAttribute::Access => "acl_access_present",
					AclAttribute::Default => "acl_default_present",
				}))
			},
			AclObservation::Failure(code) => {
				Err(acl_observation_failure(AclOperation::Query, attribute, code))
			},
			AclObservation::Cleared | AclObservation::UnsupportedRequiresQuery => {
				Err(acl_observation_failure(AclOperation::Query, attribute, "acl_query_impossible"))
			},
		}
	}

	#[cfg(all(test, target_os = "linux"))]
	mod acl_observation_tests {
		use super::{
			AclAttribute, AclObservation, AclOperation, acl_observation_failure,
			classify_acl_observation,
		};

		fn classify(
			operation: AclOperation,
			attribute: AclAttribute,
			result: libc::ssize_t,
			errno: Option<i32>,
		) -> AclObservation {
			classify_acl_observation(operation, attribute, result, errno)
		}

		#[test]
		fn clear_acl_observations_are_fail_closed_except_absence_and_exact_unsupported() {
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, 0, None),
				AclObservation::Cleared
			);
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, -1, Some(libc::ENODATA)),
				AclObservation::Absent
			);
			for errno in [libc::EOPNOTSUPP, libc::ENOTSUP] {
				assert_eq!(
					classify(AclOperation::Clear, AclAttribute::Access, -1, Some(errno)),
					AclObservation::UnsupportedRequiresQuery
				);
			}
			for errno in [libc::EACCES, libc::EPERM] {
				assert_eq!(
					classify(AclOperation::Clear, AclAttribute::Access, -1, Some(errno)),
					AclObservation::Failure("acl_clear_denied")
				);
			}
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, -1, Some(libc::EIO)),
				AclObservation::Failure("acl_clear_io")
			);
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Default, -1, Some(12345)),
				AclObservation::Failure("acl_default_clear_unknown")
			);
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, -1, Some(12345)),
				AclObservation::Failure("acl_clear_unknown")
			);
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, -1, None),
				AclObservation::Failure("acl_clear_errno_missing")
			);
			assert_eq!(
				classify(AclOperation::Clear, AclAttribute::Access, 1, None),
				AclObservation::Failure("acl_clear_impossible")
			);
		}

		#[test]
		fn query_acl_observations_are_fail_closed_except_absence_and_exact_unsupported() {
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, 1, None),
				AclObservation::Present
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, 0, None),
				AclObservation::Failure("acl_access_malformed")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Default, 0, None),
				AclObservation::Failure("acl_default_malformed")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, -1, Some(libc::ENODATA)),
				AclObservation::Absent
			);
			for errno in [libc::EOPNOTSUPP, libc::ENOTSUP] {
				assert_eq!(
					classify(AclOperation::Query, AclAttribute::Access, -1, Some(errno)),
					AclObservation::Unsupported
				);
			}
			for errno in [libc::EACCES, libc::EPERM] {
				assert_eq!(
					classify(AclOperation::Query, AclAttribute::Access, -1, Some(errno)),
					AclObservation::Failure("acl_query_denied")
				);
			}
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, -1, Some(libc::EIO)),
				AclObservation::Failure("acl_query_io")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Default, -1, Some(12345)),
				AclObservation::Failure("acl_default_query_unknown")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, -1, Some(12345)),
				AclObservation::Failure("acl_query_unknown")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, -1, None),
				AclObservation::Failure("acl_query_errno_missing")
			);
			assert_eq!(
				classify(AclOperation::Query, AclAttribute::Access, -2, None),
				AclObservation::Failure("acl_query_impossible")
			);
		}

		#[test]
		fn unsupported_clear_is_not_classified_as_acl_absence() {
			let clear =
				classify(AclOperation::Clear, AclAttribute::Access, -1, Some(libc::EOPNOTSUPP));
			assert_eq!(clear, AclObservation::UnsupportedRequiresQuery);
			assert_ne!(clear, AclObservation::Absent);
		}

		#[test]
		fn acl_failures_always_name_the_exact_operation_attribute_and_category() {
			for (operation, attribute, code, expected_code) in [
				(AclOperation::Clear, AclAttribute::Default, "acl_clear_denied", "acl_denied"),
				(AclOperation::Query, AclAttribute::Access, "acl_query_io", "acl_io_error"),
				(AclOperation::Clear, AclAttribute::Access, "acl_clear_errno_missing", "acl_unknown"),
				(
					AclOperation::Query,
					AclAttribute::Default,
					"acl_default_query_unknown",
					"acl_unknown",
				),
				(AclOperation::Query, AclAttribute::Access, "acl_access_malformed", "acl_malformed"),
				(AclOperation::Query, AclAttribute::Default, "acl_default_present", "acl_present"),
				(AclOperation::Clear, AclAttribute::Access, "acl_clear_impossible", "acl_unknown"),
			] {
				let failure = acl_observation_failure(operation, attribute, code);
				assert!(!failure.ok);
				assert_eq!(failure.code.as_deref(), Some(expected_code));
				assert_eq!(
					failure.operation.as_deref(),
					Some(match operation {
						AclOperation::Clear => "clear",
						AclOperation::Query => "query",
					})
				);
				assert_eq!(
					failure.attribute.as_deref(),
					Some(match attribute {
						AclAttribute::Access => "access",
						AclAttribute::Default => "default",
					})
				);
			}
		}
	}

	#[cfg(all(test, target_os = "linux"))]
	mod caller_fd_authority_tests {
		use std::{
			fs,
			os::fd::{AsRawFd, IntoRawFd},
			path::PathBuf,
			sync::atomic::{AtomicU64, Ordering},
		};

		use super::{checked_caller_file, checked_file, duplicate_cloexec, revalidate_authority};

		static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

		struct TempDir(PathBuf);
		impl TempDir {
			fn new() -> Self {
				let path = std::env::temp_dir().join(format!(
					"gjc-caller-fd-authority-{}-{}",
					std::process::id(),
					NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed),
				));
				fs::create_dir(&path).expect("create temp directory");
				Self(path)
			}
		}
		impl Drop for TempDir {
			fn drop(&mut self) {
				let _ = fs::remove_dir_all(&self.0);
			}
		}

		#[test]
		fn caller_fd_mismatch_and_reuse_are_rejected_and_duplicate_is_close_on_exec() {
			let root = TempDir::new();
			let expected = root.0.join("expected");
			let replacement = root.0.join("replacement");
			fs::write(&expected, b"expected").expect("write expected");
			fs::write(&replacement, b"replacement").expect("write replacement");
			let expected_file = fs::File::open(&expected).expect("open expected");
			let reused_fd = expected_file.into_raw_fd();
			assert_eq!(unsafe { libc::close(reused_fd) }, 0);
			let replacement_fd = fs::File::open(&replacement)
				.expect("open replacement")
				.into_raw_fd();
			assert_eq!(unsafe { libc::dup2(replacement_fd, reused_fd) }, reused_fd);
			if replacement_fd != reused_fd {
				assert_eq!(unsafe { libc::close(replacement_fd) }, 0);
			}
			let result = checked_caller_file(&expected, "file", reused_fd);
			assert!(result.is_err());
			let duplicate = match duplicate_cloexec(reused_fd) {
				Ok(file) => file,
				Err(_) => panic!("duplicate caller fd"),
			};
			assert_ne!(duplicate.as_raw_fd(), reused_fd);
			assert_ne!(
				unsafe { libc::fcntl(duplicate.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC,
				0
			);
			assert_eq!(unsafe { libc::close(reused_fd) }, 0);
		}

		#[test]
		fn retained_edges_detect_replacement_and_root_and_self_remain_authoritative() {
			let root = TempDir::new();
			let parent = root.0.join("parent");
			fs::create_dir(&parent).expect("create parent");
			let child = parent.join("child");
			fs::write(&child, b"child").expect("write child");
			let authority = match checked_file(&child, "file") {
				Ok(authority) => authority,
				Err(_) => panic!("open authority"),
			};
			fs::rename(&parent, root.0.join("old-parent")).expect("replace parent path");
			fs::create_dir(&parent).expect("create replacement parent");
			fs::write(parent.join("child"), b"replacement").expect("write replacement child");
			assert!(revalidate_authority(&authority).is_err());
			assert!(checked_file(std::path::Path::new("."), "directory").is_ok());
			assert!(checked_file(std::path::Path::new("/"), "directory").is_ok());
		}
	}

	#[cfg(target_os = "macos")]
	// SAFETY: these declarations match the platform C ABI.
	unsafe extern "C" {
		fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
		fn acl_init(count: libc::c_int) -> *mut libc::c_void;
		fn acl_set_fd(fd: libc::c_int, acl: *mut libc::c_void) -> libc::c_int;
		fn acl_get_entry(
			acl: *mut libc::c_void,
			entry_id: libc::c_int,
			entry: *mut *mut libc::c_void,
		) -> libc::c_int;
		fn acl_free(object: *mut libc::c_void) -> libc::c_int;
	}

	#[cfg(target_os = "macos")]
	const ACL_FIRST_ENTRY: libc::c_int = 0;

	#[cfg(target_os = "macos")]
	const fn macos_acl_unsupported(errno: Option<i32>) -> bool {
		matches!(errno, Some(libc::ENOTSUP))
	}

	#[cfg(all(test, target_os = "macos"))]
	mod macos_acl_classification_tests {
		use super::macos_acl_unsupported;

		#[test]
		fn only_enotsup_is_acl_storage_unsupported() {
			assert!(macos_acl_unsupported(Some(libc::ENOTSUP)));
			assert!(!macos_acl_unsupported(Some(libc::ENOENT)));
			assert!(!macos_acl_unsupported(Some(libc::EIO)));
			assert!(!macos_acl_unsupported(None));
		}
	}

	#[cfg(target_os = "macos")]
	#[allow(clippy::result_large_err, reason = "preserves operation-specific ACL failure evidence")]
	fn clear_extended_acl(file: &File) -> Result<(), NativeOwnerOnlySecurityResult> {
		// SAFETY: this creates an owned ACL allocation for the requested entry count.
		let acl = unsafe { acl_init(1) };
		if acl.is_null() {
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		// SAFETY: the file descriptor and owned ACL allocation remain live for this
		// call.
		let result = unsafe { acl_set_fd(file.as_raw_fd(), acl) };
		let errno = if result == 0 {
			None
		} else {
			std::io::Error::last_os_error().raw_os_error()
		};
		// SAFETY: this owns the ACL allocation from the preceding ACL API and frees it
		// once.
		unsafe { acl_free(acl) };
		if result == 0 || macos_acl_unsupported(errno) {
			Ok(())
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "macos")]
	#[allow(clippy::result_large_err, reason = "preserves operation-specific ACL failure evidence")]
	fn has_extended_acl(file: &File) -> Result<bool, NativeOwnerOnlySecurityResult> {
		// SAFETY: the file descriptor is live; the returned ACL is freed exactly once.
		let acl = unsafe { acl_get_fd(file.as_raw_fd()) };
		if acl.is_null() {
			let errno = std::io::Error::last_os_error().raw_os_error();
			// On macOS `acl_get_fd` returns NULL with errno ENOENT when the file has no
			// extended ACL; ENOTSUP likewise means the filesystem has no ACL storage.
			if matches!(errno, Some(libc::ENOENT)) || macos_acl_unsupported(errno) {
				return Ok(false);
			}
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		let mut entry = std::ptr::null_mut();
		// SAFETY: the ACL allocation is live and `entry` is a writable output pointer.
		let result = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) };
		let errno = if result == 0 {
			None
		} else {
			std::io::Error::last_os_error().raw_os_error()
		};
		// SAFETY: this owns the ACL allocation from the preceding ACL API and frees it
		// once.
		unsafe { acl_free(acl) };
		// Unlike Linux, macOS `acl_get_entry` returns 0 when it hands back an entry and
		// -1 once no entries remain, so a first-entry success means the file carries an
		// extended ACL.
		match result {
			0 => Ok(true),
			-1 if macos_acl_unsupported(errno) => Ok(false),
			-1 => Ok(false),
			_ => Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable")),
		}
	}

	#[cfg(target_os = "macos")]
	fn clear_and_verify_macos_acl(fd: libc::c_int) -> Result<(), &'static str> {
		let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
		if duplicate < 0 {
			return Err("acl_unavailable");
		}
		let file = unsafe { File::from_raw_fd(duplicate) };
		clear_extended_acl(&file).map_err(|_| "acl_apply_failed")?;
		if has_extended_acl(&file).map_err(|_| "acl_verify_failed")? {
			return Err("acl_verify_failed");
		}
		Ok(())
	}

	fn verify_authority(
		authority: &CheckedPathAuthority,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let metadata = match revalidate_authority(authority) {
			Ok(value) => value,
			Err(result) => return result,
		};
		let expected = if kind == "directory" { 0o700 } else { 0o600 };
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if metadata.st_uid != unsafe { libc::geteuid() } {
			return NativeOwnerOnlySecurityResult::failure("owner_mismatch");
		}
		if metadata.st_mode & 0o777 != expected {
			return NativeOwnerOnlySecurityResult::failure("mode_mismatch");
		}
		#[cfg(target_os = "linux")]
		{
			let access_query = match query_extended_acl(&authority.file, AclAttribute::Access) {
				Ok(evidence) => evidence,
				Err(result) => return result,
			};
			let default_query = if kind == "directory" {
				match query_extended_acl(&authority.file, AclAttribute::Default) {
					Ok(evidence) => Some(evidence),
					Err(result) => return result,
				}
			} else {
				None
			};
			match revalidate_authority(authority) {
				Ok(_) => NativeOwnerOnlySecurityResult::linux_verified_success(
					kind,
					access_query,
					default_query,
				),
				Err(result) => result,
			}
		}
		#[cfg(target_os = "macos")]
		match has_extended_acl(&authority.file) {
			Ok(false) => NativeOwnerOnlySecurityResult::success(),
			Ok(true) => NativeOwnerOnlySecurityResult::failure("acl_verify_failed"),
			Err(result) => result,
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	#[cfg(target_os = "linux")]
	pub fn secure_created_owner_only_file(file: &File) -> Result<(), &'static str> {
		let before = file.metadata().map_err(|_| "io_error")?;
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if before.uid() != unsafe { libc::geteuid() } {
			return Err("owner_mismatch");
		}
		if before.mode() & libc::S_IFMT != libc::S_IFREG {
			return Err("not_directory");
		}
		// SAFETY: file is a live retained descriptor and mode 0600 is valid for fchmod.
		if unsafe { libc::fchmod(file.as_raw_fd(), 0o600) } != 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		clear_extended_acl(file, AclAttribute::Access).map_err(|result| {
			match result.code.as_deref() {
				Some("acl_denied") => "acl_denied",
				Some("acl_io_error") => "acl_io_error",
				Some("acl_present") => "acl_present",
				Some("acl_malformed") => "acl_malformed",
				_ => "acl_unknown",
			}
		})?;
		query_extended_acl(file, AclAttribute::Access).map_err(|result| {
			match result.code.as_deref() {
				Some("acl_denied") => "acl_denied",
				Some("acl_io_error") => "acl_io_error",
				Some("acl_present") => "acl_present",
				Some("acl_malformed") => "acl_malformed",
				_ => "acl_unknown",
			}
		})?;
		let after = file.metadata().map_err(|_| "io_error")?;
		if after.dev() != before.dev() || after.ino() != before.ino() {
			return Err("identity_mismatch");
		}
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if after.uid() != unsafe { libc::geteuid() } {
			return Err("owner_mismatch");
		}
		if after.mode() & 0o777 != 0o600 {
			return Err("mode_mismatch");
		}
		Ok(())
	}

	#[cfg(target_os = "linux")]
	pub fn verify_created_owner_only_file(file: &File) -> Result<(), &'static str> {
		let metadata = file.metadata().map_err(|_| "io_error")?;
		if metadata.file_type().is_symlink() || !metadata.is_file() {
			return Err("not_directory");
		}
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if metadata.uid() != unsafe { libc::geteuid() } {
			return Err("owner_mismatch");
		}
		if metadata.mode() & 0o777 != 0o600 {
			return Err("mode_mismatch");
		}
		query_extended_acl(file, AclAttribute::Access).map_err(|result| {
			match result.code.as_deref() {
				Some("acl_denied") => "acl_denied",
				Some("acl_io_error") => "acl_io_error",
				Some("acl_present") => "acl_present",
				Some("acl_malformed") => "acl_malformed",
				_ => "acl_unknown",
			}
		})?;
		Ok(())
	}

	#[cfg(target_os = "linux")]
	pub fn verify_retained_owner_only_directory(file: &File) -> Result<(), &'static str> {
		let metadata = file.metadata().map_err(|_| "io_error")?;
		if !metadata.is_dir() {
			return Err("not_directory");
		}
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if metadata.uid() != unsafe { libc::geteuid() } {
			return Err("owner_mismatch");
		}
		if metadata.mode() & 0o777 != 0o700 {
			return Err("mode_mismatch");
		}
		for attribute in [AclAttribute::Access, AclAttribute::Default] {
			query_extended_acl(file, attribute).map_err(|result| match result.code.as_deref() {
				Some("acl_denied") => "acl_denied",
				Some("acl_io_error") => "acl_io_error",
				Some("acl_present") => "acl_present",
				Some("acl_malformed") => "acl_malformed",
				_ => "acl_unknown",
			})?;
		}
		Ok(())
	}

	#[cfg(target_os = "linux")]
	pub fn secure_created_owner_only_directory(file: &File) -> Result<(), &'static str> {
		let metadata = file.metadata().map_err(|_| "io_error")?;
		if !metadata.is_dir() {
			return Err("not_directory");
		}
		// SAFETY: geteuid has no preconditions and only reads process credentials.
		if metadata.uid() != unsafe { libc::geteuid() } {
			return Err("owner_mismatch");
		}
		// SAFETY: file is a live retained directory descriptor and mode 0700 is valid.
		if unsafe { libc::fchmod(file.as_raw_fd(), 0o700) } != 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		for attribute in [AclAttribute::Access, AclAttribute::Default] {
			clear_extended_acl(file, attribute).map_err(|result| match result.code.as_deref() {
				Some("acl_denied") => "acl_denied",
				Some("acl_io_error") => "acl_io_error",
				Some("acl_present") => "acl_present",
				Some("acl_malformed") => "acl_malformed",
				_ => "acl_unknown",
			})?;
		}
		verify_retained_owner_only_directory(file)
	}

	fn apply_authority(
		authority: CheckedPathAuthority,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		// The retained path/name chain and the selected descriptor must agree before
		// any mutation.
		let metadata = match revalidate_authority(&authority) {
			Ok(metadata) => metadata,
			Err(result) => return result,
		};
		// SAFETY: geteuid has no preconditions and only reads the process effective
		// user identity.
		if metadata.st_uid != unsafe { libc::geteuid() } {
			return NativeOwnerOnlySecurityResult::failure("owner_mismatch");
		}
		let mode = if kind == "directory" { 0o700 } else { 0o600 };
		// SAFETY: authority.file is retained and live, and mode is exactly 0600 or
		// 0700.
		if unsafe { libc::fchmod(authority.file.as_raw_fd(), mode) } != 0 {
			return NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			));
		}
		#[cfg(target_os = "linux")]
		{
			// Each attribute is cleared and then immediately queried. In particular, do
			// not let a successful access-ACL clear authorize mutating the default ACL.
			let access_clear = match clear_extended_acl(&authority.file, AclAttribute::Access) {
				Ok(evidence) => evidence,
				Err(result) => return result,
			};
			let access_query = match query_extended_acl(&authority.file, AclAttribute::Access) {
				Ok(evidence) => evidence,
				Err(result) => return result,
			};
			let default_evidence = if kind == "directory" {
				let clear = match clear_extended_acl(&authority.file, AclAttribute::Default) {
					Ok(evidence) => evidence,
					Err(result) => return result,
				};
				let query = match query_extended_acl(&authority.file, AclAttribute::Default) {
					Ok(evidence) => evidence,
					Err(result) => return result,
				};
				Some((clear, query))
			} else {
				None
			};
			match revalidate_authority(&authority) {
				Ok(_) => NativeOwnerOnlySecurityResult::linux_success(
					kind,
					access_clear,
					access_query,
					default_evidence,
				),
				Err(result) => result,
			}
		}
		#[cfg(target_os = "macos")]
		if let Err(result) = clear_extended_acl(&authority.file) {
			return result;
		}
		#[cfg(not(target_os = "linux"))]
		verify_authority(&authority, kind)
	}

	#[cfg(target_os = "linux")]
	#[allow(clippy::result_large_err, reason = "preserves structured native security evidence")]
	fn checked_caller_file(
		path: &Path,
		kind: &str,
		caller_fd: libc::c_int,
	) -> Result<CheckedPathAuthority, NativeOwnerOnlySecurityResult> {
		let mut authority = checked_file(path, kind)?;
		let caller = duplicate_cloexec(caller_fd)?;
		let caller_stat = fstat(caller.as_raw_fd())?;
		if !stat_same_object(&authority.initial, &caller_stat) {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
		}
		authority.file = caller;
		// Verify the retained path authority again after taking the caller descriptor.
		revalidate_authority(&authority)?;
		Ok(authority)
	}

	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		match checked_file(path, kind) {
			Ok(authority) => apply_authority(authority, kind),
			Err(result) => result,
		}
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		match checked_file(path, kind) {
			Ok(authority) => verify_authority(&authority, kind),
			Err(result) => result,
		}
	}
	pub(super) fn verify_owner_only_path_security_expected(
		_: &Path,
		_: &str,
		_: u64,
		_: u64,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	pub(super) fn repair_owner_only_path_security_expected(
		_: &Path,
		_: &str,
		_: u64,
		_: u64,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	#[cfg(target_os = "linux")]
	pub(super) fn apply_owner_only_fd_security(
		path: &Path,
		kind: &str,
		caller_fd: libc::c_int,
	) -> NativeOwnerOnlySecurityResult {
		match checked_caller_file(path, kind, caller_fd) {
			Ok(authority) => apply_authority(authority, kind),
			Err(result) => result,
		}
	}

	#[cfg(not(target_os = "linux"))]
	pub(super) fn apply_owner_only_fd_security(
		_: &Path,
		_: &str,
		_: libc::c_int,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	#[cfg(target_os = "linux")]
	pub(super) fn verify_owner_only_fd_security(
		path: &Path,
		kind: &str,
		caller_fd: libc::c_int,
	) -> NativeOwnerOnlySecurityResult {
		match checked_caller_file(path, kind, caller_fd) {
			Ok(authority) => verify_authority(&authority, kind),
			Err(result) => result,
		}
	}

	#[cfg(not(target_os = "linux"))]
	pub(super) fn verify_owner_only_fd_security(
		_: &Path,
		_: &str,
		_: libc::c_int,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	#[cfg(target_os = "linux")]
	fn rename_no_replace(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		// A signal delivered while the syscall is blocked yields EINTR without any
		// filesystem side effect (the rename simply did not happen yet). POSIX
		// wrappers conventionally restart in that case; retry a bounded number of
		// times so a stray signal during a large migration cannot surface as a
		// spurious, unretried failure. Any other errno is returned immediately.
		for _ in 0..EINTR_RETRY_LIMIT {
			if take_injected_rename_no_replace_eintr() {
				continue;
			}
			// SAFETY: the descriptor and both NUL-terminated CString pointers remain valid.
			let result = unsafe {
				libc::syscall(
					libc::SYS_renameat2,
					source_parent_fd,
					source.as_ptr(),
					destination_parent_fd,
					destination.as_ptr(),
					libc::RENAME_NOREPLACE,
				)
			};
			if result == 0 {
				return Ok(());
			}
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => return Err("quarantine_collision"),
				Some(libc::ENOSYS) => return Err("atomic_unavailable"),
				// Fixed no-replace syscall arguments make EINVAL an invocation/filesystem
				// divergence, not proof that the primitive is unavailable.
				Some(libc::EINVAL) => return Err("invalid_request"),
				Some(libc::EXDEV) => return Err("cross_device"),
				Some(libc::EACCES | libc::EPERM) => return Err("permission_denied"),
				Some(libc::EINTR) => {},
				_ => return Err("io_error"),
			}
		}
		Err("interrupted")
	}

	#[cfg(target_os = "linux")]
	fn rename_directory_no_replace_at(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		// `renameat2(RENAME_NOREPLACE)` is unavailable on some shared mounts. Claim
		// the destination with mkdirat, then replace only that still-empty directory.
		// The caller has already validated the source descriptor and parent identity.
		// SAFETY: the parent descriptor is live and destination is NUL-terminated.
		if unsafe { libc::mkdirat(destination_parent_fd, destination.as_ptr(), 0o700) } != 0 {
			return Err(match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST | libc::ENOTEMPTY) => "quarantine_collision",
				Some(libc::ENOENT) => "not_found",
				Some(libc::EACCES | libc::EPERM) => "permission_denied",
				_ => "io_error",
			});
		}
		// SAFETY: both parent descriptors and names remain valid for the syscall.
		let renamed = unsafe {
			libc::renameat(
				source_parent_fd,
				source.as_ptr(),
				destination_parent_fd,
				destination.as_ptr(),
			)
		};
		if renamed == 0 {
			Ok(())
		} else {
			let error = std::io::Error::last_os_error();
			// SAFETY: remove only the empty directory claimed by this call.
			unsafe { libc::unlinkat(destination_parent_fd, destination.as_ptr(), libc::AT_REMOVEDIR) };
			Err(match error.raw_os_error() {
				Some(libc::EEXIST | libc::ENOTEMPTY) => "quarantine_collision",
				Some(libc::ENOENT) => "not_found",
				Some(libc::EACCES | libc::EPERM) => "permission_denied",
				_ => "io_error",
			})
		}
	}

	#[cfg(not(target_os = "linux"))]
	fn rename_directory_no_replace_at(
		_: libc::c_int,
		_: libc::c_int,
		_: &CString,
		_: &CString,
	) -> Result<(), &'static str> {
		Err("atomic_unavailable")
	}

	#[cfg(target_os = "linux")]
	fn rename_exchange(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		if take_injected_rename_exchange_failure() {
			return Err("io_error");
		}
		// SAFETY: the descriptor and both NUL-terminated CString pointers remain valid.
		let result = unsafe {
			libc::syscall(
				libc::SYS_renameat2,
				source_parent_fd,
				source.as_ptr(),
				destination_parent_fd,
				destination.as_ptr(),
				libc::RENAME_EXCHANGE,
			)
		};
		if result == 0 {
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::ENOSYS | libc::EINVAL) => Err("atomic_unavailable"),
				_ => Err("io_error"),
			}
		}
	}

	#[cfg(target_os = "macos")]
	// SAFETY: these declarations match the platform C ABI.
	unsafe extern "C" {
		fn renameatx_np(
			fromfd: libc::c_int,
			from: *const libc::c_char,
			tofd: libc::c_int,
			to: *const libc::c_char,
			flags: u32,
		) -> libc::c_int;
	}

	#[cfg(target_os = "macos")]
	fn rename_no_replace(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		const RENAME_EXCL: u32 = 0x0000_0004;
		// A signal delivered while the syscall is blocked yields EINTR without any
		// filesystem side effect (the rename simply did not happen yet). POSIX
		// wrappers conventionally restart in that case; retry a bounded number of
		// times so a stray signal during a large migration cannot surface as a
		// spurious, unretried failure. Any other errno is returned immediately.
		for _ in 0..EINTR_RETRY_LIMIT {
			if take_injected_rename_no_replace_eintr() {
				continue;
			}
			// SAFETY: both descriptors and NUL-terminated CString pointers remain valid.
			let result = unsafe {
				renameatx_np(
					source_parent_fd,
					source.as_ptr(),
					destination_parent_fd,
					destination.as_ptr(),
					RENAME_EXCL,
				)
			};
			if result == 0 {
				return Ok(());
			}
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => return Err("quarantine_collision"),
				Some(libc::ENOSYS) => return Err("atomic_unavailable"),
				Some(libc::EINVAL) => return Err("invalid_request"),
				Some(libc::EXDEV) => return Err("cross_device"),
				Some(libc::EACCES | libc::EPERM) => return Err("permission_denied"),
				Some(libc::EINTR) => {},
				_ => return Err("io_error"),
			}
		}
		Err("interrupted")
	}

	#[cfg(target_os = "macos")]
	fn rename_exchange(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
		if take_injected_rename_exchange_failure() {
			return Err("io_error");
		}
		const RENAME_SWAP: u32 = 0x0000_0002;
		// SAFETY: both descriptors and NUL-terminated CString pointers remain valid.
		if unsafe {
			renameatx_np(
				source_parent_fd,
				source.as_ptr(),
				destination_parent_fd,
				destination.as_ptr(),
				RENAME_SWAP,
			)
		} == 0
		{
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::ENOSYS | libc::EINVAL) => Err("atomic_unavailable"),
				_ => Err("io_error"),
			}
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn rename_no_replace(
		_: libc::c_int,
		_: libc::c_int,
		_: &CString,
		_: &CString,
	) -> Result<(), &'static str> {
		Err("atomic_unavailable")
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn rename_exchange(
		_: libc::c_int,
		_: libc::c_int,
		_: &CString,
		_: &CString,
	) -> Result<(), &'static str> {
		Err("atomic_unavailable")
	}

	#[derive(Clone, Copy)]

	struct ExchangePlaceholderIdentity {
		dev:       u64,
		ino:       u64,
		directory: bool,
	}

	fn create_exchange_placeholder(
		parent_fd: libc::c_int,
		name: &CString,
		directory: bool,
	) -> Result<ExchangePlaceholderIdentity, &'static str> {
		// Darwin RENAME_SWAP requires same-kind entries. The placeholder also keeps the
		// mutable name occupied until the exchanged object is identity-checked.
		let created = if directory {
			// SAFETY: `parent_fd` is live and `name` is a NUL-terminated component.
			unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o700) }
		} else {
			// SAFETY: `parent_fd` is live and `name` is a NUL-terminated component.
			let fd = unsafe {
				libc::openat(
					parent_fd,
					name.as_ptr(),
					libc::O_CREAT | libc::O_EXCL | libc::O_WRONLY | libc::O_CLOEXEC,
					0o600,
				)
			};
			if fd >= 0 {
				// SAFETY: this branch owns the placeholder descriptor exactly once.
				unsafe { libc::close(fd) };
				0
			} else {
				-1
			}
		};
		if created != 0 {
			return match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => Err("quarantine_collision"),
				_ => Err("io_error"),
			};
		}

		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut placeholder: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		if unsafe {
			libc::fstatat(parent_fd, name.as_ptr(), &mut placeholder, libc::AT_SYMLINK_NOFOLLOW)
		} != 0 || (placeholder.st_mode & libc::S_IFMT == libc::S_IFDIR) != directory
		{
			return Err("io_error");
		}
		Ok(ExchangePlaceholderIdentity {
			dev: placeholder.st_dev as u64,
			ino: placeholder.st_ino as u64,
			directory,
		})
	}

	#[allow(dead_code, reason = "retained cleanup outcomes are platform-conditional")]
	enum ExchangePlaceholderRemoval {
		Removed,
		RetainedMismatch(CString),
		Failed,
		RetainedFailure(CString, &'static str),
	}

	fn exchange_placeholder_quarantine_name(expected: ExchangePlaceholderIdentity) -> CString {
		CString::new(format!(".gjc-exact-unlink-placeholder-{:x}-{:x}", expected.dev, expected.ino))
			.expect("placeholder quarantine name contains no NUL")
	}
	fn remove_exchange_placeholder(
		parent_fd: libc::c_int,
		name: &CString,
		expected: ExchangePlaceholderIdentity,
	) -> ExchangePlaceholderRemoval {
		let detached_name = exchange_placeholder_quarantine_name(expected);
		// Atomically detach the mutable canonical entry before inspecting it. The
		// no-replace destination prevents a concurrent publisher from being
		// overwritten, and all subsequent deletion targets this detached pathname.
		if rename_no_replace(parent_fd, parent_fd, name, &detached_name).is_err() {
			return ExchangePlaceholderRemoval::Failed;
		}
		#[cfg(test)]
		pause_after_placeholder_detach_for_test();
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut detached: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		let matches = unsafe {
			libc::fstatat(parent_fd, detached_name.as_ptr(), &mut detached, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && (detached.st_mode & libc::S_IFMT == libc::S_IFDIR)
			== expected.directory
			&& detached.st_dev as u64 == expected.dev
			&& detached.st_ino as u64 == expected.ino;

		if !matches {
			return ExchangePlaceholderRemoval::RetainedMismatch(detached_name);
		}
		ExchangePlaceholderRemoval::RetainedFailure(detached_name, "cleanup_pending")
	}

	fn digest_openat(parent_fd: libc::c_int, name: &CString) -> Result<[u8; 32], &'static str> {
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let fd = unsafe {
			libc::openat(parent_fd, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
		};
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		// SAFETY: this uniquely transfers the live descriptor to `File` ownership.
		let mut file = unsafe { File::from_raw_fd(fd) };
		digest_reader(&mut file).map_err(|_| "io_error")
	}

	fn scrub_regular_file_openat(
		parent_fd: libc::c_int,
		name: &CString,
		identity: &ExactFileIdentity,
	) -> Result<(), &'static str> {
		// SAFETY: `parent_fd` and `name` are live; flags request an exact no-follow
		// regular-file descriptor.
		let fd = unsafe {
			libc::openat(parent_fd, name.as_ptr(), libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW)
		};
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let result = (|| {
			let validate = || -> Result<(), &'static str> {
				// SAFETY: zero is a valid initialized representation for `fstat` output.
				let mut stat: libc::stat = unsafe { std::mem::zeroed() };
				// SAFETY: `fd` is live and `stat` is writable for the duration of the call.
				if unsafe { libc::fstat(fd, &mut stat) } != 0 {
					return Err(security_code(&std::io::Error::last_os_error()));
				}
				if stat.st_mode & libc::S_IFMT != libc::S_IFREG
					|| stat.st_dev as u64 != identity.dev
					|| stat.st_ino as u64 != identity.ino
					|| stat.st_size as u64 != identity.size
					|| stat_mtime_ns(&stat) != i128::from(identity.mtime_ns)
				{
					return Err("identity_mismatch");
				}
				if stat.st_nlink != 1 {
					return Err("hard_link_unsupported");
				}
				// SAFETY: `fd` is live and seeking only resets its shared read offset before
				// digesting.
				if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
					return Err(security_code(&std::io::Error::last_os_error()));
				}
				// SAFETY: `fd` is live; the returned descriptor is checked before ownership
				// transfer.
				let duplicated = unsafe { libc::dup(fd) };
				if duplicated < 0 {
					return Err(security_code(&std::io::Error::last_os_error()));
				}
				// SAFETY: `duplicated` is a unique checked descriptor transferred to `File`
				// exactly once.
				let mut file = unsafe { File::from_raw_fd(duplicated) };
				if digest_reader(&mut file).ok().as_ref() != identity.sha256.as_ref() {
					return Err("identity_mismatch");
				}
				Ok(())
			};
			validate()?;
			validate()?;
			// SAFETY: `fd` is the live, twice-revalidated, single-link transcript
			// descriptor.
			if unsafe { libc::ftruncate(fd, 0) } != 0 {
				return Err(security_code(&std::io::Error::last_os_error()));
			}
			// SAFETY: both descriptors remain live and are synchronized before return.
			let file_synced = unsafe { libc::fsync(fd) } == 0;
			// SAFETY: `parent_fd` remains live and binds the quarantine namespace.
			let parent_synced = unsafe { libc::fsync(parent_fd) } == 0;
			if !file_synced || !parent_synced {
				return Err("durability_failed");
			}
			Ok(())
		})();
		// SAFETY: this function owns `fd` and closes it exactly once after the
		// operation.
		unsafe { libc::close(fd) };
		result
	}

	pub(super) fn exact_unlink(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let walk_path = descriptor_walk_path(path);
		let base = if walk_path.is_absolute() {
			b"/\0"
		} else {
			b".\0"
		};
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return NativeExactUnlinkResult::failure(security_code(&std::io::Error::last_os_error()));
		}
		let mut segments = Vec::new();
		for component in walk_path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(parent_fd) };
					return NativeExactUnlinkResult::failure("io_error");
				},
			}
		}
		let Some((name_bytes, ancestors)) = segments.split_last() else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		for segment_bytes in ancestors {
			let Ok(segment) = CString::new(segment_bytes.as_slice()) else {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("io_error");
			};
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: the descriptor and CString are live; the initialized output struct is
			// writable.
			if unsafe {
				libc::fstatat(parent_fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} != 0
			{
				let error = std::io::Error::last_os_error();
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure(security_code(&error));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("reparse_point");
			}
			// SAFETY: the live descriptor, where used, and NUL-terminated path remain
			// valid.
			let next_fd = unsafe {
				libc::openat(
					parent_fd,
					segment.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			if next_fd < 0 {
				return NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				));
			}
			parent_fd = next_fd;
		}
		if let Some((expected_dev, expected_ino)) = identity.parent_dev.zip(identity.parent_ino) {
			// SAFETY: zero is valid initialized storage for `fstat` output.
			let mut parent_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: `parent_fd` is the retained walked parent descriptor.
			if unsafe { libc::fstat(parent_fd, &mut parent_stat) } != 0
				|| parent_stat.st_dev as u64 != expected_dev
				|| parent_stat.st_ino as u64 != expected_ino
			{
				// SAFETY: this branch owns `parent_fd` exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("parent_mismatch");
			}
		}
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let result = exact_unlink_at(parent_fd, name, path, identity);
		// SAFETY: this function owns the walked parent descriptor exactly once.
		unsafe { libc::close(parent_fd) };
		result
	}

	/// Remove one regular file without invoking the exchange protocol. The
	/// caller supplies a private, single-component quarantine name; the
	/// no-replace rename is the mutation boundary that detaches whichever entry
	/// currently occupies the public pathname. The detached entry is then
	/// revalidated against the captured identity before its private name is
	/// unlinked. A mismatch is restored with another no-replace rename whenever
	/// the public pathname is still vacant.
	pub(super) fn exact_unlink_direct(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if identity.directory || identity.detach_only {
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
			return NativeExactUnlinkResult::failure("quarantine_destination_required");
		};
		if quarantine_name.is_empty()
			|| quarantine_name == "."
			|| quarantine_name == ".."
			|| quarantine_name.as_bytes().contains(&b'/')
		{
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		let (parent_fd, name) = match open_parent_no_follow(path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		let close_parent = |result: NativeExactUnlinkResult| {
			// SAFETY: this operation owns the walked parent descriptor exactly once.
			unsafe { libc::close(parent_fd) };
			result
		};
		if let Some((expected_dev, expected_ino)) = identity.parent_dev.zip(identity.parent_ino) {
			// SAFETY: zero is valid initialized storage for fstat output.
			let mut parent_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: parent_fd is the retained walked parent descriptor.
			if unsafe { libc::fstat(parent_fd, &mut parent_stat) } != 0
				|| parent_stat.st_dev as u64 != expected_dev
				|| parent_stat.st_ino as u64 != expected_ino
			{
				return close_parent(NativeExactUnlinkResult::failure("parent_mismatch"));
			}
		}
		let Ok(quarantine) = CString::new(quarantine_name) else {
			return close_parent(NativeExactUnlinkResult::failure("invalid_request"));
		};
		match exact_regular_matches(parent_fd, &name, identity) {
			Ok(true) => {},
			Ok(false) => return close_parent(NativeExactUnlinkResult::failure("identity_mismatch")),
			Err(code) => return close_parent(NativeExactUnlinkResult::failure(code)),
		}
		if let Err(code) = rename_no_replace(parent_fd, parent_fd, &name, &quarantine) {
			return close_parent(NativeExactUnlinkResult::failure(code));
		}
		let detached_path = path
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(quarantine_name)
			.to_string_lossy()
			.into_owned();
		let detached_matches =
			matches!(exact_regular_matches(parent_fd, &quarantine, identity), Ok(true));
		if !detached_matches {
			return if rename_no_replace(parent_fd, parent_fd, &quarantine, &name).is_ok() {
				close_parent(NativeExactUnlinkResult::failure("identity_mismatch"))
			} else {
				close_parent(NativeExactUnlinkResult::detached_failure(
					"identity_mismatch",
					detached_path,
				))
			};
		}
		// SAFETY: parent_fd and the private quarantine name remain live; the
		// detached entry was revalidated against the caller's exact identity.
		if unsafe { libc::unlinkat(parent_fd, quarantine.as_ptr(), 0) } == 0 {
			return close_parent(NativeExactUnlinkResult::success());
		}
		let code = security_code(&std::io::Error::last_os_error());
		if rename_no_replace(parent_fd, parent_fd, &quarantine, &name).is_ok() {
			close_parent(NativeExactUnlinkResult::failure(code))
		} else {
			close_parent(NativeExactUnlinkResult::detached_failure("cleanup_pending", detached_path))
		}
	}

	fn exact_unlink_at(
		parent_fd: libc::c_int,
		name: CString,
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			let error = std::io::Error::last_os_error();
			return NativeExactUnlinkResult::failure(security_code(&error));
		}
		if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
			return NativeExactUnlinkResult::failure("reparse_point");
		}
		let expected_kind = if identity.directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		if named.st_mode & libc::S_IFMT != expected_kind {
			return NativeExactUnlinkResult::failure(if identity.directory {
				"not_directory"
			} else {
				"not_regular_file"
			});
		}
		if named.st_dev as u64 != identity.dev
			|| named.st_ino as u64 != identity.ino
			|| named.st_size as u64 != identity.size
			|| stat_mtime_ns(&named) != i128::from(identity.mtime_ns)
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory
			&& !identity.allow_hard_link
			&& (named.st_nlink != 1 || identity.nlink.is_some_and(|nlink| nlink != 1))
		{
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		if !identity.directory
			&& digest_openat(parent_fd, &name).ok().as_ref() != identity.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}

		let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
			return NativeExactUnlinkResult::failure("quarantine_destination_required");
		};
		let Ok(quarantine) = CString::new(quarantine_name) else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let placeholder =
			match create_exchange_placeholder(parent_fd, &quarantine, identity.directory) {
				Ok(placeholder) => placeholder,
				Err(code) => {
					return NativeExactUnlinkResult::failure(code);
				},
			};
		// Exchange keeps the canonical pathname occupied by an empty directory while
		// the detached object is verified. A regular-file rename cannot replace that
		// directory, so a rename-published successor cannot be deleted by cleanup.
		#[cfg(test)]
		pause_before_exchange_for_test();
		if let Err(code) = rename_exchange(parent_fd, parent_fd, &name, &quarantine) {
			let cleanup = remove_exchange_placeholder(parent_fd, &quarantine, placeholder);
			return match cleanup {
				ExchangePlaceholderRemoval::Removed => NativeExactUnlinkResult::failure(code),
				ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
					NativeExactUnlinkResult::retained_unknown_failure(
						"cleanup_failed",
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedFailure(retained_name, _) => {
					NativeExactUnlinkResult::retained_placeholder_failure(
						"cleanup_failed",
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::Failed => {
					NativeExactUnlinkResult::retained_unknown_failure(
						"cleanup_failed",
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(quarantine.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
			};
		}
		#[cfg(test)]
		pause_after_exchange_for_test();
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut detached: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		let matches = unsafe {
			libc::fstatat(parent_fd, quarantine.as_ptr(), &mut detached, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && detached.st_mode & libc::S_IFMT == expected_kind
			&& detached.st_dev as u64 == identity.dev
			&& detached.st_ino as u64 == identity.ino
			&& detached.st_size as u64 == identity.size
			&& stat_mtime_ns(&detached) == i128::from(identity.mtime_ns);
		let digest_matches = identity.directory
			|| digest_openat(parent_fd, &quarantine).ok().as_ref() == identity.sha256.as_ref();
		let detached_path = path
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(quarantine.to_string_lossy().as_ref())
			.to_string_lossy()
			.into_owned();
		if !matches || !digest_matches {
			// Do not exchange an untrusted detached object over the canonical name.
			// Detach the canonical entry first; this preserves a successor at its
			// canonical path or reports its retained recovery path while the stale
			// object remains available at its quarantine path.
			let result = match remove_exchange_placeholder(parent_fd, &name, placeholder) {
				ExchangePlaceholderRemoval::Removed => {
					NativeExactUnlinkResult::detached_failure("identity_mismatch", detached_path)
				},
				ExchangePlaceholderRemoval::Failed => {
					NativeExactUnlinkResult::detached_failure_with_unknown(
						"identity_mismatch",
						detached_path,
						path.to_string_lossy().into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
					NativeExactUnlinkResult::detached_failure_with_unknown(
						"identity_mismatch",
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedFailure(retained_name, code) => {
					NativeExactUnlinkResult::detached_failure_with_placeholder(
						code,
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
			};
			return result;
		}
		if identity.directory || identity.detach_only {
			let result = match remove_exchange_placeholder(parent_fd, &name, placeholder) {
				ExchangePlaceholderRemoval::Removed => NativeExactUnlinkResult::detached(detached_path),
				ExchangePlaceholderRemoval::Failed => {
					NativeExactUnlinkResult::detached_failure_with_unknown(
						"identity_mismatch",
						detached_path,
						path.to_string_lossy().into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
					NativeExactUnlinkResult::detached_failure_with_unknown(
						"identity_mismatch",
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedFailure(retained_name, code) => {
					NativeExactUnlinkResult::detached_failure_with_placeholder(
						code,
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
			};
			return result;
		}
		if identity.allow_hard_link {
			if !matches!(exact_regular_matches(parent_fd, &quarantine, identity), Ok(true)) {
				return NativeExactUnlinkResult::detached_failure("identity_mismatch", detached_path);
			}
			// SAFETY: parent_fd and the private quarantine name remain live and
			// identity-verified.
			let unlinked = unsafe { libc::unlinkat(parent_fd, quarantine.as_ptr(), 0) } == 0;
			// SAFETY: parent_fd remains live and binds the mutated quarantine namespace.
			let synced = unsafe { libc::fsync(parent_fd) } == 0;
			if !unlinked || !synced {
				return NativeExactUnlinkResult::detached_failure_with_durable_payload_and_placeholder(
					"cleanup_pending",
					detached_path,
					path.to_string_lossy().into_owned(),
				);
			}
			return match remove_exchange_placeholder(parent_fd, &name, placeholder) {
				ExchangePlaceholderRemoval::Removed => NativeExactUnlinkResult::success(),
				ExchangePlaceholderRemoval::RetainedFailure(retained_name, code) => {
					NativeExactUnlinkResult::detached_failure_with_durable_payload_and_placeholder(
						code,
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
					NativeExactUnlinkResult::detached_failure_with_durable_payload_and_unknown(
						"cleanup_pending",
						detached_path,
						path
							.parent()
							.unwrap_or_else(|| Path::new("."))
							.join(retained_name.to_string_lossy().as_ref())
							.to_string_lossy()
							.into_owned(),
					)
				},
				ExchangePlaceholderRemoval::Failed => {
					NativeExactUnlinkResult::failure("cleanup_pending")
				},
			};
		}
		// POSIX cannot descriptor-unlink, but it can descriptor-scrub the exact
		// detached regular file. Durable zero-length retained entries are then
		// reconciled as internal placeholders without preserving transcript bytes.
		if let Err(code) = scrub_regular_file_openat(parent_fd, &quarantine, identity) {
			return NativeExactUnlinkResult::detached_failure(code, detached_path);
		}
		match remove_exchange_placeholder(parent_fd, &name, placeholder) {
			ExchangePlaceholderRemoval::Removed => NativeExactUnlinkResult::success(),
			ExchangePlaceholderRemoval::RetainedFailure(retained_name, code) => {
				NativeExactUnlinkResult::detached_failure_with_durable_payload_and_placeholder(
					code,
					detached_path,
					path
						.parent()
						.unwrap_or_else(|| Path::new("."))
						.join(retained_name.to_string_lossy().as_ref())
						.to_string_lossy()
						.into_owned(),
				)
			},
			ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
				NativeExactUnlinkResult::detached_failure_with_durable_payload_and_unknown(
					"cleanup_pending",
					detached_path,
					path
						.parent()
						.unwrap_or_else(|| Path::new("."))
						.join(retained_name.to_string_lossy().as_ref())
						.to_string_lossy()
						.into_owned(),
				)
			},
			ExchangePlaceholderRemoval::Failed => {
				NativeExactUnlinkResult::detached_failure_with_durable_payload_and_unknown(
					"cleanup_pending",
					detached_path,
					path.to_string_lossy().into_owned(),
				)
			},
		}
	}

	fn open_parent_no_follow(
		path: &Path,
	) -> Result<(libc::c_int, CString), Box<NativeExactUnlinkResult>> {
		let walk_path = descriptor_walk_path(path);
		let base = if walk_path.is_absolute() {
			b"/\0"
		} else {
			b".\0"
		};
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return Err(Box::new(NativeExactUnlinkResult::failure(security_code(
				&std::io::Error::last_os_error(),
			))));
		}
		let mut segments = Vec::new();
		for component in walk_path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(parent_fd) };
					return Err(Box::new(NativeExactUnlinkResult::failure("io_error")));
				},
			}
		}
		let Some((name_bytes, ancestors)) = segments.split_last() else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return Err(Box::new(NativeExactUnlinkResult::failure("io_error")));
		};
		for segment_bytes in ancestors {
			let Ok(segment) = CString::new(segment_bytes.as_slice()) else {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return Err(Box::new(NativeExactUnlinkResult::failure("io_error")));
			};
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: the descriptor and CString are live; the initialized output struct is
			// writable.
			if unsafe {
				libc::fstatat(parent_fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} != 0
			{
				let error = std::io::Error::last_os_error();
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return Err(Box::new(NativeExactUnlinkResult::failure(security_code(&error))));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return Err(Box::new(NativeExactUnlinkResult::failure("reparse_point")));
			}
			// SAFETY: the live descriptor, where used, and NUL-terminated path remain
			// valid.
			let next_fd = unsafe {
				libc::openat(
					parent_fd,
					segment.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			if next_fd < 0 {
				return Err(Box::new(NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				))));
			}
			parent_fd = next_fd;
		}
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return Err(Box::new(NativeExactUnlinkResult::failure("io_error")));
		};
		Ok((parent_fd, name))
	}

	fn skill_write_error(error: &std::io::Error) -> &'static str {
		match error.raw_os_error() {
			Some(libc::ELOOP) => "reparse_point",
			Some(libc::ENOENT) => "not_found",
			Some(libc::ENOTDIR) => "not_directory",
			Some(libc::EISDIR) => "not_regular_file",
			Some(libc::EACCES | libc::EPERM) => "permission_denied",
			Some(libc::EROFS) => "permission_denied",
			Some(libc::EEXIST) => "already_exists",
			Some(libc::EINVAL) => "invalid_request",
			Some(libc::EINTR) => "interrupted",
			Some(libc::ENOSPC) => "no_space",
			Some(libc::ENAMETOOLONG) => "name_too_long",
			Some(libc::EFBIG) => "content_too_large",
			_ => "io_error",
		}
	}

	/// Open one directory component beneath a retained descriptor, creating it
	/// only when the name is absent. The second open is still `O_NOFOLLOW`, so a
	/// concurrent symlink insertion after `mkdirat` fails closed.
	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained parent descriptor and NUL-terminated component remain live across \
		          each syscall"
	)]
	fn open_or_create_skill_directory(
		parent_fd: libc::c_int,
		name: &CString,
	) -> Result<(libc::c_int, bool), &'static str> {
		let flags = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
		let opened = unsafe { libc::openat(parent_fd, name.as_ptr(), flags) };
		if opened >= 0 {
			return Ok((opened, false));
		}
		let first_error = std::io::Error::last_os_error();
		if first_error.raw_os_error() != Some(libc::ENOENT) {
			return Err(skill_write_error(&first_error));
		}
		let created = if unsafe { libc::mkdirat(parent_fd, name.as_ptr(), 0o700) } != 0 {
			let mkdir_error = std::io::Error::last_os_error();
			if mkdir_error.raw_os_error() != Some(libc::EEXIST) {
				return Err(skill_write_error(&mkdir_error));
			}
			false
		} else {
			true
		};
		let created_identity = if created {
			statat_fd(parent_fd, name).ok()
		} else {
			None
		};
		let reopened = unsafe { libc::openat(parent_fd, name.as_ptr(), flags) };
		if reopened < 0 {
			let error = std::io::Error::last_os_error();
			if let Some(expected) = created_identity {
				let _ = remove_created_directory_if_exact(parent_fd, name, &expected);
			}
			return Err(skill_write_error(&error));
		}
		Ok((reopened, created))
	}

	/// Retained authority for a skills root.  Holding every traversed edge lets
	/// the final publication re-check that the descriptor still has the same
	/// pathname reachability it had when opened; a caller must not publish into
	/// a directory that has since been detached and replaced at its public path.
	struct SkillRootAuthority {
		file:      libc::c_int,
		canonical: PathBuf,
		edges:     Vec<AuthorityEdge>,
	}

	impl Drop for SkillRootAuthority {
		fn drop(&mut self) {
			// SAFETY: The descriptor was opened by this authority walk. The validity
			// probe avoids closing a descriptor already released by an established
			// early-return cleanup path.
			if unsafe { libc::fcntl(self.file, libc::F_GETFD) } >= 0 {
				// SAFETY: The descriptor remains owned by this authority until Drop completes.
				unsafe { libc::close(self.file) };
			}
		}
	}

	fn revalidate_skill_root(authority: &SkillRootAuthority) -> Result<(), &'static str> {
		for edge in &authority.edges {
			let parent = fstat(edge.parent.as_raw_fd()).map_err(|_| "identity_mismatch")?;
			let child = fstat(edge.child.as_raw_fd()).map_err(|_| "identity_mismatch")?;
			let named = statat(&edge.parent, &edge.name).map_err(|_| "identity_mismatch")?;
			if !stat_same_object(&edge.parent_initial, &parent)
				|| !stat_same_object(&edge.child_initial, &child)
				|| !stat_same_object(&edge.child_initial, &named)
			{
				return Err("identity_mismatch");
			}
		}
		if let Some(edge) = authority.edges.last() {
			let root = fstat(authority.file).map_err(|_| "identity_mismatch")?;
			if !stat_same_object(&edge.child_initial, &root) {
				return Err("identity_mismatch");
			}
		}
		Ok(())
	}

	fn revalidate_skill_directory(
		authority: &SkillRootAuthority,
		name: &CString,
		directory_fd: libc::c_int,
	) -> Result<(), &'static str> {
		revalidate_skill_root(authority)?;
		let named = statat_fd(authority.file, name).map_err(|_| "identity_mismatch")?;
		let actual = fstat(directory_fd).map_err(|_| "identity_mismatch")?;
		if named.st_mode & libc::S_IFMT != libc::S_IFDIR
			|| actual.st_mode & libc::S_IFMT != libc::S_IFDIR
			|| !stat_same_object(&named, &actual)
		{
			return Err("identity_mismatch");
		}
		Ok(())
	}

	fn statat_fd(parent_fd: libc::c_int, name: &CString) -> Result<libc::stat, &'static str> {
		// SAFETY: `named` is initialized before libc writes the stat record.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `parent_fd` is an open directory descriptor and `name` is
		// NUL-terminated.
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			return Err("identity_mismatch");
		}
		if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
			return Err("reparse_point");
		}
		Ok(named)
	}

	fn remove_created_directory_if_exact(
		parent_fd: libc::c_int,
		name: &CString,
		expected: &libc::stat,
	) -> Result<(), &'static str> {
		let current = statat_fd(parent_fd, name)?;
		if current.st_mode & libc::S_IFMT != libc::S_IFDIR || !stat_same_object(expected, &current) {
			return Err("identity_mismatch");
		}
		// SAFETY: `parent_fd` is an open directory descriptor and `name` is
		// NUL-terminated.
		if unsafe { libc::unlinkat(parent_fd, name.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
			return Err(skill_write_error(&std::io::Error::last_os_error()));
		}
		Ok(())
	}

	/// Descriptor-walk an absolute path, creating missing directories along the
	/// way. The returned path is the no-alias spelling used by the walk (not a
	/// second, race-prone `realpath` lookup).
	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the walk owns the current descriptor and closes each predecessor exactly once"
	)]
	fn open_or_create_skill_root(
		path: &Path,
		directory_mode: libc::mode_t,
	) -> Result<SkillRootAuthority, &'static str> {
		let walk_path = descriptor_walk_path(path);
		if !walk_path.is_absolute() {
			return Err("invalid_request");
		}
		let current = unsafe {
			libc::open(
				c"/".as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if current < 0 {
			return Err(skill_write_error(&std::io::Error::last_os_error()));
		}
		let mut current = unsafe { File::from_raw_fd(current) };
		let mut canonical = PathBuf::from("/");
		let mut edges = Vec::new();
		for component in walk_path.components() {
			let segment = match component {
				Component::Normal(segment) => segment,
				Component::RootDir | Component::CurDir => continue,
				Component::ParentDir | Component::Prefix(_) => {
					return Err("invalid_request");
				},
			};
			let Ok(name) = CString::new(segment.as_bytes()) else {
				return Err("invalid_request");
			};
			let (next, created) = match open_or_create_skill_directory(current.as_raw_fd(), &name) {
				Ok(next) => next,
				Err(code) => {
					return Err(code);
				},
			};
			let next = unsafe { File::from_raw_fd(next) };
			let child_identity = fstat(next.as_raw_fd()).map_err(|_| "io_error")?;
			if created && unsafe { libc::fchmod(next.as_raw_fd(), directory_mode) } != 0 {
				let code = skill_write_error(&std::io::Error::last_os_error());
				let cleanup =
					remove_created_directory_if_exact(current.as_raw_fd(), &name, &child_identity);
				drop(next);
				return Err(cleanup.err().unwrap_or(code));
			}
			if created && let Err(code) = fsync_root_parent(current.as_raw_fd()) {
				let cleanup =
					remove_created_directory_if_exact(current.as_raw_fd(), &name, &child_identity);
				drop(next);
				return Err(cleanup.err().unwrap_or(code));
			}
			let parent_initial = fstat(current.as_raw_fd()).map_err(|_| "io_error")?;
			let child_initial = fstat(next.as_raw_fd()).map_err(|_| "io_error")?;
			let named = statat(&current, &name).map_err(|_| "identity_mismatch")?;
			if !stat_same_object(&child_initial, &named) {
				return Err("identity_mismatch");
			}
			let child = next.try_clone().map_err(|_| "io_error")?;
			edges.push(AuthorityEdge { parent: current, parent_initial, name, child, child_initial });
			current = next;
			canonical.push(segment);
		}
		Ok(SkillRootAuthority { file: current.into_raw_fd(), canonical, edges })
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained parent descriptor and no-follow final name remain live through \
		          inspection"
	)]
	fn inspect_existing_skill_file(
		parent_fd: libc::c_int,
		name: &CString,
	) -> Result<Option<u32>, &'static str> {
		let fd = unsafe {
			libc::openat(
				parent_fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if fd < 0 {
			let error = std::io::Error::last_os_error();
			return if error.raw_os_error() == Some(libc::ENOENT) {
				Ok(None)
			} else {
				Err(skill_write_error(&error))
			};
		}
		let result = (|| {
			let mut information: libc::stat = unsafe { std::mem::zeroed() };
			if unsafe { libc::fstat(fd, &mut information) } != 0 {
				return Err(skill_write_error(&std::io::Error::last_os_error()));
			}
			if information.st_mode & libc::S_IFMT != libc::S_IFREG {
				return Err("not_regular_file");
			}
			if information.st_nlink > 1 {
				return Err("hard_link");
			}
			Ok(Some((information.st_mode & 0o7777) as u32))
		})();
		unsafe { libc::close(fd) };
		result
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained skill-directory descriptor owns the unique private file name"
	)]
	fn create_private_skill_file(
		parent_fd: libc::c_int,
	) -> Result<(File, CString, u32), &'static str> {
		for _ in 0..16 {
			let sequence = NEXT_SECURE_SKILL_TEMP_ID.fetch_add(1, Ordering::Relaxed);
			// The staging name is visible to other processes in the retained directory,
			// so do not make it enumerable from the process id and a counter alone.  The
			// link-count proof below still rejects an observed race; this token only
			// removes the predictable window in which an attacker could pre-position a
			// hard-link operation before the writer has even created the inode.
			let mut entropy = [0_u8; 16];
			let mut entropy_source = File::open("/dev/urandom").map_err(|_| "io_error")?;
			entropy_source
				.read_exact(&mut entropy)
				.map_err(|_| "io_error")?;
			let token = u128::from_ne_bytes(entropy);
			let name = CString::new(format!(
				".gjc-skill-write-{}-{}-{token:032x}",
				std::process::id(),
				sequence,
			))
			.expect("private skill name contains no NUL");
			let fd = unsafe {
				libc::openat(
					parent_fd,
					name.as_ptr(),
					libc::O_WRONLY
						| libc::O_CREAT
						| libc::O_EXCL
						| libc::O_CLOEXEC
						| libc::O_NOFOLLOW
						| libc::O_NONBLOCK,
					// Start every staging inode owner-only. Project mode is restored only
					// after the final identity checks, immediately before publication.
					0o600,
				)
			};
			if fd < 0 {
				let error = std::io::Error::last_os_error();
				if error.raw_os_error() == Some(libc::EEXIST) {
					continue;
				}
				return Err(skill_write_error(&error));
			}
			let mut information: libc::stat = unsafe { std::mem::zeroed() };
			if unsafe { libc::fstat(fd, &mut information) } != 0 {
				let error = std::io::Error::last_os_error();
				let cleaned = unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } == 0;
				unsafe { libc::close(fd) };
				return Err(if cleaned {
					skill_write_error(&error)
				} else {
					"cleanup_failed"
				});
			}
			let effective_mode = information.st_mode & 0o7777;
			if unsafe { libc::fchmod(fd, 0o600) } != 0 {
				let error = std::io::Error::last_os_error();
				let cleaned = unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } == 0;
				unsafe { libc::close(fd) };
				return Err(if cleaned {
					skill_write_error(&error)
				} else {
					"cleanup_failed"
				});
			}
			if information.st_mode & libc::S_IFMT != libc::S_IFREG || information.st_nlink != 1 {
				let cleaned = unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } == 0;
				unsafe { libc::close(fd) };
				return Err(if cleaned {
					"identity_mismatch"
				} else {
					"cleanup_failed"
				});
			}
			return Ok((unsafe { File::from_raw_fd(fd) }, name, effective_mode as u32));
		}
		Err("race_limit")
	}

	enum SkillPublicationError {
		Pre(&'static str),
		Post { code: &'static str, staging_aliases: bool },
	}

	fn replace_skill_file_name(
		parent_fd: libc::c_int,
		private_name: &CString,
		final_name: &CString,
		private_fd: libc::c_int,
		requested_mode: Option<u32>,
		root: &SkillRootAuthority,
		skill_name: &CString,
	) -> Result<(), SkillPublicationError> {
		#[cfg(test)]
		pause_secure_skill_write_before_rename_for_test();
		if revalidate_skill_directory(root, skill_name, parent_fd).is_err() {
			return Err(SkillPublicationError::Pre("identity_mismatch"));
		}
		// SAFETY: Both stat values are initialized output buffers.
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `named` is initialized before libc writes the stat record.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `private_fd` is retained for the publication transaction.
		let opened_ok = unsafe { libc::fstat(private_fd, &mut opened) } == 0;
		// SAFETY: `parent_fd` retains the destination directory and the name is
		// NUL-terminated.
		let named_ok = unsafe {
			libc::fstatat(parent_fd, private_name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
		} == 0;
		if !opened_ok
			|| !named_ok
			|| opened.st_mode & libc::S_IFMT != libc::S_IFREG
			|| opened.st_nlink != 1
			|| named.st_mode & libc::S_IFMT != libc::S_IFREG
			|| named.st_nlink != 1
			|| opened.st_dev != named.st_dev
			|| opened.st_ino != named.st_ino
		{
			return Err(SkillPublicationError::Pre("identity_mismatch"));
		}
		if let Some(mode) = requested_mode {
			// Keep the private inode owner-only until all identity checks pass, then
			// restore the published mode on the retained descriptor immediately
			// before the atomic rename. This avoids exposing a project payload under
			// its staging name while ensuring publication never has a 0600 mode gap.
			// SAFETY: `private_fd` is the retained regular-file descriptor validated
			// above, and `mode` contains only the permitted file mode bits.
			if unsafe { libc::fchmod(private_fd, mode as libc::mode_t) } != 0 {
				return Err(SkillPublicationError::Pre(skill_write_error(
					&std::io::Error::last_os_error(),
				)));
			}
			// The mode change is part of the payload publication transaction; make
			// it durable before exposing the inode under its final name.
			// SAFETY: `private_fd` is the open staging file descriptor retained above.
			if unsafe { libc::fsync(private_fd) } != 0 {
				return Err(SkillPublicationError::Pre("durability_failed"));
			}
		}
		// SAFETY: `parent_fd` retains the destination directory and both names are
		// NUL-terminated.
		if unsafe { libc::renameat(parent_fd, private_name.as_ptr(), parent_fd, final_name.as_ptr()) }
			!= 0
		{
			return Err(SkillPublicationError::Pre(skill_write_error(
				&std::io::Error::last_os_error(),
			)));
		}
		// SAFETY: `published` is an initialized output buffer for the retained
		// destination directory.
		let mut published: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `private_fd` is retained for the publication transaction.
		let opened_after_ok = unsafe { libc::fstat(private_fd, &mut opened) } == 0;
		// SAFETY: `parent_fd` retains the destination directory and the name is
		// NUL-terminated.
		let published_ok = unsafe {
			libc::fstatat(parent_fd, final_name.as_ptr(), &mut published, libc::AT_SYMLINK_NOFOLLOW)
		} == 0;
		let valid = opened_after_ok
			&& published_ok
			&& opened.st_mode & libc::S_IFMT == libc::S_IFREG
			&& opened.st_nlink == 1
			&& published.st_mode & libc::S_IFMT == libc::S_IFREG
			&& published.st_nlink == 1
			&& opened.st_dev == published.st_dev
			&& opened.st_ino == published.st_ino;
		if valid {
			return Ok(());
		}
		// A hard link created after the pre-rename check moved the staged inode
		// into the public name while retaining the attacker's alias.  Unlike an
		// independent stat failure, this is a proven unsafe publication: the
		// payload must be scrubbed through the retained descriptor before the
		// caller reports failure.  The public name is removed only after an exact
		// descriptor/name comparison, so a concurrent successor is never touched.
		let staging_aliases =
			(opened_after_ok && opened.st_nlink != 1) || (published_ok && published.st_nlink != 1);
		// The rename is already committed. Never unlink the public name from a
		// transient validation failure: the retained descriptor still owns the
		// newly published payload, and a later fstatat may be observing a safe
		// publication despite the independent fstat failure.
		Err(SkillPublicationError::Post { code: "identity_mismatch", staging_aliases })
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained published descriptor and parent descriptor remain live through exact \
		          scrub"
	)]
	fn scrub_published_skill_file(
		file: &File,
		parent_fd: libc::c_int,
		name: &CString,
	) -> Result<(), &'static str> {
		if file.set_len(0).is_err() || file.sync_all().is_err() {
			return Err("cleanup_failed");
		}
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		let same = unsafe { libc::fstat(file.as_raw_fd(), &mut opened) } == 0
			&& unsafe {
				libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} == 0 && opened.st_dev == named.st_dev
			&& opened.st_ino == named.st_ino;
		if !same {
			return Ok(());
		}
		if unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } != 0 {
			return Err("cleanup_failed");
		}
		Ok(())
	}

	/// Scrub a publication that has already crossed the rename boundary before
	/// returning a failure.  The retained descriptor is the authority for the
	/// payload, while the pathname is removed only after an exact
	/// descriptor/name comparison; a concurrent successor is therefore never
	/// consumed by cleanup.
	fn fail_published_skill_file(
		file: File,
		skill_fd: libc::c_int,
		skills_fd: libc::c_int,
		final_name: &CString,
		code: &'static str,
	) -> NativeSecureSkillWriteResult {
		let cleanup = scrub_published_skill_file(&file, skill_fd, final_name);
		drop(file);
		// SAFETY: this operation owns both duplicated directory descriptors exactly
		// once; the retained root authority owns and closes its separate descriptor.
		unsafe {
			libc::close(skill_fd);
			libc::close(skills_fd);
		}
		NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code))
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained published descriptor and parent descriptor remain live through final \
		          validation"
	)]
	fn published_skill_file_is_valid(
		file: &File,
		parent_fd: libc::c_int,
		name: &CString,
		expected_mode: Option<u32>,
	) -> Result<bool, &'static str> {
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstat(file.as_raw_fd(), &mut opened) } != 0 {
			return Err("identity_mismatch");
		}
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			return Err("identity_mismatch");
		}
		Ok(opened.st_mode & libc::S_IFMT == libc::S_IFREG
			&& named.st_mode & libc::S_IFMT == libc::S_IFREG
			&& expected_mode.is_none_or(|mode| {
				(opened.st_mode as u32 & 0o7777) == mode && (named.st_mode as u32 & 0o7777) == mode
			}) && opened.st_nlink == 1
			&& named.st_nlink == 1
			&& opened.st_dev == named.st_dev
			&& opened.st_ino == named.st_ino)
	}

	fn unlink_private_skill_file(
		parent_fd: libc::c_int,
		name: &CString,
		private_fd: libc::c_int,
	) -> Result<(), &'static str> {
		// SAFETY: Both stat values are initialized output buffers.
		let mut opened: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `named` is initialized before libc writes the stat record.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: The retained descriptors remain valid and the name is NUL-terminated.
		let same = unsafe { libc::fstat(private_fd, &mut opened) } == 0
			&& unsafe {
				libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} == 0 && opened.st_dev == named.st_dev
			&& opened.st_ino == named.st_ino;
		if !same {
			return Err("cleanup_failed");
		}
		#[cfg(test)]
		if FAIL_SECURE_SKILL_CLEANUP.swap(false, Ordering::Relaxed) {
			return Err("cleanup_failed");
		}
		// SAFETY: `parent_fd` retains the parent directory and `name` is
		// NUL-terminated.
		if unsafe { libc::unlinkat(parent_fd, name.as_ptr(), 0) } != 0 {
			return Err("cleanup_failed");
		}
		Ok(())
	}

	fn cleanup_private_skill_file(
		file: &File,
		parent_fd: libc::c_int,
		name: &CString,
	) -> Result<(), &'static str> {
		let private_fd = file.as_raw_fd();
		// Scrubbing must reach stable storage before the staging name is removed;
		// otherwise a crash can resurrect a failed payload through a retained alias.
		let scrubbed = file.set_len(0).is_ok() && file.sync_all().is_ok();
		let unlinked = scrubbed && unlink_private_skill_file(parent_fd, name, private_fd).is_ok();
		if scrubbed && unlinked {
			Ok(())
		} else {
			Err("cleanup_failed")
		}
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained directory and private file handles remain live through complete \
		          publication"
	)]
	pub(super) fn secure_write_skill_file(
		root_path: &Path,
		skill_name: &str,
		content: &str,
		file_mode: u32,
	) -> NativeSecureSkillWriteResult {
		let directory_mode = if file_mode == 0o600 { 0o700 } else { 0o755 };
		let root = match open_or_create_skill_root(root_path, directory_mode) {
			Ok(value) => value,
			Err(code) => return NativeSecureSkillWriteResult::failure(code),
		};
		// Keep the authority walk's descriptor owned solely by `SkillRootAuthority`.
		// The writer uses a separate descriptor because its existing error paths close
		// the skill-root handle after private-file cleanup.
		// SAFETY: `root.file` is an open directory descriptor owned by `root`.
		let skills_fd = unsafe { libc::fcntl(root.file, libc::F_DUPFD_CLOEXEC, 0) };
		if skills_fd < 0 {
			return NativeSecureSkillWriteResult::failure("io_error");
		}
		#[cfg(target_os = "linux")]
		let canonical_root = root.canonical.clone();
		let Ok(skill_component) = CString::new(skill_name.as_bytes()) else {
			unsafe { libc::close(skills_fd) };
			return NativeSecureSkillWriteResult::failure("invalid_request");
		};
		let (skill_fd, skill_created) =
			match open_or_create_skill_directory(skills_fd, &skill_component) {
				Ok(fd) => fd,
				Err(code) => {
					// SAFETY: `skills_fd` is the private duplicate owned by this
					// function; `SkillRootAuthority` retains and closes the original.
					unsafe { libc::close(skills_fd) };
					return NativeSecureSkillWriteResult::failure(code);
				},
			};
		if skill_created && unsafe { libc::fchmod(skill_fd, directory_mode) } != 0 {
			let code = skill_write_error(&std::io::Error::last_os_error());
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure(code);
		}
		if revalidate_skill_directory(&root, &skill_component, skill_fd).is_err() {
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure("identity_mismatch");
		}
		if file_mode == 0o600 {
			#[cfg(target_os = "linux")]
			let directory_security = apply_owner_only_fd_security(&canonical_root, "directory", skills_fd)
				.is_ok() && apply_owner_only_fd_security(
				&canonical_root.join(skill_name),
				"directory",
				skill_fd,
			)
			.is_ok();
			#[cfg(not(target_os = "linux"))]
			let directory_security = unsafe { libc::fchmod(skills_fd, 0o700) } == 0
				&& unsafe { libc::fchmod(skill_fd, 0o700) } == 0;
			if !directory_security {
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure("permission_denied");
			}
			#[cfg(target_os = "macos")]
			if clear_and_verify_macos_acl(skills_fd).is_err()
				|| clear_and_verify_macos_acl(skill_fd).is_err()
			{
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure("acl_verify_failed");
			}
		}
		if revalidate_skill_directory(&root, &skill_component, skill_fd).is_err() {
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure("identity_mismatch");
		}
		let Ok(final_name) = CString::new("SKILL.md") else {
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure("invalid_request");
		};
		let existing_mode = match inspect_existing_skill_file(skill_fd, &final_name) {
			Ok(mode) => mode,
			Err(code) => {
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(code);
			},
		};
		let requested_file_mode = existing_mode.unwrap_or(file_mode);
		// Keep the staging name owner-only regardless of the requested published
		// mode. Project skills are eventually 0644, but exposing their plaintext
		// while the private name is live would permit an observer to retain a
		// second hard link and defeat the single-link publication invariant.
		let (mut file, private_name, _created_mode) = match create_private_skill_file(skill_fd) {
			Ok(value) => value,
			Err(code) => {
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(code);
			},
		};
		// Harden every private staging inode, including project-scope writes.  A
		// parent default ACL can grant read access despite mode 0600; clear and
		// verify it before any payload bytes are written or the name is replaced.
		#[cfg(target_os = "linux")]
		if let Err(code) = secure_created_owner_only_file(&file) {
			let cleanup = cleanup_private_skill_file(&file, skill_fd, &private_name);
			drop(file);
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code));
		}
		#[cfg(target_os = "macos")]
		if let Err(code) = clear_and_verify_macos_acl(file.as_raw_fd()) {
			let cleanup = cleanup_private_skill_file(&file, skill_fd, &private_name);
			drop(file);
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code));
		}
		if file.write_all(content.as_bytes()).is_err() {
			let cleanup = cleanup_private_skill_file(&file, skill_fd, &private_name);
			drop(file);
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or("write_failed"));
		}
		// `File` is currently unbuffered, but flush explicitly keeps this boundary
		// correct if the writer ever gains a buffering layer: all payload bytes must
		// reach the kernel before the durability fence and namespace replacement.
		if file.flush().is_err() || file.sync_all().is_err() {
			let cleanup = cleanup_private_skill_file(&file, skill_fd, &private_name);
			drop(file);
			unsafe {
				libc::close(skill_fd);
				libc::close(skills_fd);
			}
			return NativeSecureSkillWriteResult::failure(
				cleanup.err().unwrap_or("durability_failed"),
			);
		}
		let private_fd = file.as_raw_fd();
		match replace_skill_file_name(
			skill_fd,
			&private_name,
			&final_name,
			private_fd,
			(file_mode != 0o600).then_some(requested_file_mode),
			&root,
			&skill_component,
		) {
			Ok(()) => {},
			Err(SkillPublicationError::Pre(code)) => {
				let cleanup = cleanup_private_skill_file(&file, skill_fd, &private_name);
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code));
			},
			Err(SkillPublicationError::Post { code, staging_aliases }) => {
				if staging_aliases {
					let cleanup = scrub_published_skill_file(&file, skill_fd, &final_name);
					drop(file);
					unsafe {
						libc::close(skill_fd);
						libc::close(skills_fd);
					}
					return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code));
				}
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(code);
			},
		}
		// A hard link can be added after the post-rename check. Re-check the
		// retained inode before returning success; if the single-link invariant no
		// longer holds, scrub the inode and remove only our exact public name before
		// returning failure.
		let expected_published_mode = if file_mode == 0o600 {
			0o600
		} else {
			requested_file_mode
		};
		match published_skill_file_is_valid(
			&file,
			skill_fd,
			&final_name,
			Some(expected_published_mode),
		) {
			Ok(true) => {},
			Ok(false) => {
				let cleanup = scrub_published_skill_file(&file, skill_fd, &final_name);
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(
					cleanup.err().unwrap_or("identity_mismatch"),
				);
			},
			Err(code) => {
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(code);
			},
		}
		if revalidate_skill_directory(&root, &skill_component, skill_fd).is_err() {
			return fail_published_skill_file(
				file,
				skill_fd,
				skills_fd,
				&final_name,
				"identity_mismatch",
			);
		}
		if let Err(code) = fsync_root_parent(skill_fd) {
			return fail_published_skill_file(file, skill_fd, skills_fd, &final_name, code);
		}
		if skill_created && let Err(code) = fsync_root_parent(skills_fd) {
			return fail_published_skill_file(file, skill_fd, skills_fd, &final_name, code);
		}
		// The directory fsyncs above can block long enough for the public skill
		// directory to be detached and replaced. Revalidate the retained binding
		// immediately before returning success so the receipt names the object
		// that discovery can still reach through the requested root.
		if revalidate_skill_directory(&root, &skill_component, skill_fd).is_err() {
			return fail_published_skill_file(
				file,
				skill_fd,
				skills_fd,
				&final_name,
				"identity_mismatch",
			);
		}
		// Keep the file binding as the final publication check as well.  The root
		// revalidation above can itself race with a writer that replaces SKILL.md;
		// never return a success receipt for an inode that is no longer the one
		// retained by this transaction.
		match published_skill_file_is_valid(
			&file,
			skill_fd,
			&final_name,
			Some(expected_published_mode),
		) {
			Ok(true) => {},
			Ok(false) => {
				let cleanup = scrub_published_skill_file(&file, skill_fd, &final_name);
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(
					cleanup.err().unwrap_or("identity_mismatch"),
				);
			},
			Err(code) => {
				drop(file);
				unsafe {
					libc::close(skill_fd);
					libc::close(skills_fd);
				}
				return NativeSecureSkillWriteResult::failure(code);
			},
		}
		drop(file);
		unsafe {
			libc::close(skill_fd);
			libc::close(skills_fd);
		}
		NativeSecureSkillWriteResult::success(
			root_path
				.join(skill_name)
				.join("SKILL.md")
				.to_string_lossy()
				.into_owned(),
		)
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "owned descriptors remain live through validation and close exactly once on every \
		          branch"
	)]
	fn open_publication_source(
		parent_fd: libc::c_int,
		name: &CString,
	) -> Result<(libc::c_int, libc::stat), &'static str> {
		let fd = unsafe {
			libc::openat(
				parent_fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstat(fd, &mut stat) } != 0 || stat.st_mode & libc::S_IFMT != libc::S_IFREG
		{
			unsafe { libc::close(fd) };
			return Err("identity_mismatch");
		}
		Ok((fd, stat))
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained parent descriptor and writable stat buffer remain live for the full \
		          probe"
	)]
	fn published_matches_open_source(
		parent_fd: libc::c_int,
		name: &CString,
		source: &libc::stat,
	) -> bool {
		let mut current: libc::stat = unsafe { std::mem::zeroed() };
		(unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut current, libc::AT_SYMLINK_NOFOLLOW) })
			== 0 && current.st_mode & libc::S_IFMT == libc::S_IFREG
			&& current.st_dev == source.st_dev
			&& current.st_ino == source.st_ino
			&& current.st_size == source.st_size
			&& stat_mtime_ns(&current) == stat_mtime_ns(source)
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained parent descriptor and exact identity remain live through quarantine \
		          cleanup"
	)]
	fn cleanup_substituted_publication(
		parent_fd: libc::c_int,
		name: &CString,
		path: &Path,
	) -> NativeExactUnlinkResult {
		let mut current: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut current, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0 || current.st_mode & libc::S_IFMT != libc::S_IFREG
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		let Ok(digest) = digest_openat(parent_fd, name) else {
			return NativeExactUnlinkResult::failure("identity_mismatch");
		};
		let mut parent: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstat(parent_fd, &mut parent) } != 0 {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let identity = ExactFileIdentity {
			dev:             current.st_dev as u64,
			ino:             current.st_ino as u64,
			nlink:           Some(current.st_nlink as u64),
			parent_dev:      Some(parent.st_dev as u64),
			parent_ino:      Some(parent.st_ino as u64),
			size:            current.st_size as u64,
			mtime_ns:        stat_mtime_ns(&current) as i64,
			directory:       false,
			detach_only:     false,
			quarantine_name: Some(format!(
				".gjc-substitution-cleanup-{:x}-{:x}-{:x}",
				current.st_dev,
				current.st_ino,
				std::process::id(),
			)),
			sha256:          Some(digest),
			allow_hard_link: true,
		};
		exact_unlink_at(parent_fd, name.clone(), path, &identity)
	}

	fn directory_publish_error(error: &std::io::Error) -> &'static str {
		match error.raw_os_error() {
			Some(libc::EEXIST | libc::ENOTEMPTY) => "quarantine_collision",
			Some(libc::ENOENT) => "not_found",
			Some(libc::EACCES | libc::EPERM) => "permission_denied",
			Some(libc::EXDEV) => "cross_device",
			Some(libc::EINTR) => "interrupted",
			Some(libc::EINVAL) => "invalid_request",
			_ => "io_error",
		}
	}

	/// Descriptor-relative directory publication used when the filesystem
	/// rejects `renameat2(RENAME_NOREPLACE)`. `mkdirat` claims the destination
	/// name exclusively; the plain `renameat` can then replace only that empty
	/// directory. A non-empty destination (including an attacker-published
	/// `info` file) is never overwritten, and every parent/final component is
	/// opened with no-follow semantics.
	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "publication descriptors are owned here and closed exactly once on every branch"
	)]
	pub(super) fn rename_directory_path_no_replace(
		source_path: &Path,
		destination_path: &Path,
	) -> NativeExactUnlinkResult {
		let (source_parent, source_name) = match open_parent_no_follow(source_path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		let source_fd = unsafe {
			libc::openat(
				source_parent,
				source_name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if source_fd < 0 {
			let result =
				NativeExactUnlinkResult::failure(security_code(&std::io::Error::last_os_error()));
			unsafe { libc::close(source_parent) };
			return result;
		}
		let mut source_stat: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe { libc::fstat(source_fd, &mut source_stat) } != 0 {
			let result =
				NativeExactUnlinkResult::failure(security_code(&std::io::Error::last_os_error()));
			unsafe {
				libc::close(source_fd);
				libc::close(source_parent);
			}
			return result;
		}
		let (destination_parent, destination_name) = match open_parent_no_follow(destination_path) {
			Ok(value) => value,
			Err(result) => {
				unsafe {
					libc::close(source_fd);
					libc::close(source_parent);
				}
				return *result;
			},
		};
		let mut source_named: libc::stat = unsafe { std::mem::zeroed() };
		let source_still_matches = unsafe {
			libc::fstatat(
				source_parent,
				source_name.as_ptr(),
				&mut source_named,
				libc::AT_SYMLINK_NOFOLLOW,
			)
		} == 0 && source_named.st_mode & libc::S_IFMT == libc::S_IFDIR
			&& source_named.st_dev == source_stat.st_dev
			&& source_named.st_ino == source_stat.st_ino;
		if !source_still_matches {
			unsafe {
				libc::close(source_fd);
				libc::close(source_parent);
				libc::close(destination_parent);
			}
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if unsafe { libc::mkdirat(destination_parent, destination_name.as_ptr(), 0o700) } != 0 {
			let result = NativeExactUnlinkResult::failure(directory_publish_error(
				&std::io::Error::last_os_error(),
			));
			unsafe {
				libc::close(source_fd);
				libc::close(source_parent);
				libc::close(destination_parent);
			}
			return result;
		}
		let rename_result = unsafe {
			libc::renameat(
				source_parent,
				source_name.as_ptr(),
				destination_parent,
				destination_name.as_ptr(),
			)
		};
		let result = if rename_result == 0 {
			let mut published: libc::stat = unsafe { std::mem::zeroed() };
			let verified = unsafe {
				libc::fstatat(
					destination_parent,
					destination_name.as_ptr(),
					&mut published,
					libc::AT_SYMLINK_NOFOLLOW,
				)
			} == 0 && published.st_mode & libc::S_IFMT == libc::S_IFDIR
				&& published.st_dev == source_stat.st_dev
				&& published.st_ino == source_stat.st_ino;
			if verified {
				NativeExactUnlinkResult::success()
			} else {
				NativeExactUnlinkResult::failure("destination_identity_changed")
			}
		} else {
			let error = std::io::Error::last_os_error();
			// Best-effort cleanup removes only the empty directory this call claimed.
			// ENOTEMPTY deliberately leaves a contender's metadata untouched.
			unsafe {
				libc::unlinkat(destination_parent, destination_name.as_ptr(), libc::AT_REMOVEDIR);
			}
			NativeExactUnlinkResult::failure(directory_publish_error(&error))
		};
		unsafe {
			libc::close(source_fd);
			libc::close(source_parent);
			libc::close(destination_parent);
		}
		result
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "publication descriptors are owned here and closed exactly once on every branch"
	)]
	pub(super) fn rename_path_no_replace(
		source_path: &Path,
		destination_path: &Path,
	) -> NativeExactUnlinkResult {
		let (source_parent, source_name) = match open_parent_no_follow(source_path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		let mut source_named: libc::stat = unsafe { std::mem::zeroed() };
		if unsafe {
			libc::fstatat(
				source_parent,
				source_name.as_ptr(),
				&mut source_named,
				libc::AT_SYMLINK_NOFOLLOW,
			)
		} != 0
		{
			unsafe { libc::close(source_parent) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if source_named.st_mode & libc::S_IFMT == libc::S_IFDIR {
			let (destination_parent, destination_name) = match open_parent_no_follow(destination_path)
			{
				Ok(value) => value,
				Err(result) => {
					unsafe { libc::close(source_parent) };
					return *result;
				},
			};
			let result =
				rename_no_replace(source_parent, destination_parent, &source_name, &destination_name);
			unsafe {
				libc::close(source_parent);
				libc::close(destination_parent);
			}
			return match result {
				Ok(()) => NativeExactUnlinkResult::success(),
				Err(code) => NativeExactUnlinkResult::failure(code),
			};
		}
		let (source_fd, source_stat) = match open_publication_source(source_parent, &source_name) {
			Ok(value) => value,
			Err(code) => {
				unsafe { libc::close(source_parent) };
				return NativeExactUnlinkResult::failure(code);
			},
		};
		let (destination_parent, destination_name) = match open_parent_no_follow(destination_path) {
			Ok(value) => value,
			Err(result) => {
				// SAFETY: open_parent_no_follow returned this owned, live descriptor; this
				// error branch transfers it nowhere and closes it exactly once before
				// returning.
				unsafe {
					libc::close(source_fd);
					libc::close(source_parent);
				}
				return *result;
			},
		};
		let result =
			rename_no_replace(source_parent, destination_parent, &source_name, &destination_name);
		let outcome = match result {
			Ok(())
				if published_matches_open_source(
					destination_parent,
					&destination_name,
					&source_stat,
				) =>
			{
				NativeExactUnlinkResult::success()
			},
			Ok(()) => NativeExactUnlinkResult::failure("destination_identity_changed"),
			Err(code) => NativeExactUnlinkResult::failure(code),
		};
		unsafe {
			libc::close(source_fd);
			libc::close(source_parent);
			libc::close(destination_parent);
		}
		outcome
	}

	/// No-overwrite publish of a regular file for filesystems that implement no
	/// `renameat2`/`renameatx_np` rename flag at all. NFS rejects every flag
	/// with `EINVAL` and kernels older than 3.15 answer `ENOSYS`;
	/// `rename_path_no_replace` reports those as `invalid_request` and
	/// `atomic_unavailable`, and this is the stand-in the caller may then use.
	/// `linkat(2)` fails with `EEXIST` when the destination name already
	/// exists, so the no-overwrite guarantee is identical on every POSIX
	/// filesystem: the fallback preserves — never weakens — no-replace
	/// authority.
	///
	/// Unlike a rename this leaves the source name in place, and that asymmetry
	/// is deliberate. The caller keeps whatever descriptor authority it holds
	/// over the staged object across publication and removes the staging link
	/// itself once that authority has been released. Unlinking a still-open
	/// name on NFS silly-renames it to `.nfsXXXX` rather than removing it,
	/// which would leave a second link on the published inode, so only the
	/// caller can order the two steps correctly.
	///
	/// Directories are rejected before the syscall: `linkat` cannot hard-link a
	/// directory, and reporting that as an identity violation keeps a directory
	/// publish from silently degrading into a partial one.
	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "publication descriptors are owned here and closed exactly once on every branch"
	)]
	pub(super) fn link_path_no_replace(
		source_path: &Path,
		destination_path: &Path,
	) -> NativeExactUnlinkResult {
		let (source_parent, source_name) = match open_parent_no_follow(source_path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		let (source_fd, source_stat) = match open_publication_source(source_parent, &source_name) {
			Ok(value) => value,
			Err(code) => {
				unsafe { libc::close(source_parent) };
				return NativeExactUnlinkResult::failure(code);
			},
		};
		let (destination_parent, destination_name) = match open_parent_no_follow(destination_path) {
			Ok(value) => value,
			Err(result) => {
				// SAFETY: open_parent_no_follow returned this owned, live descriptor; this
				// error branch transfers it nowhere and closes it exactly once before
				// returning.
				unsafe {
					libc::close(source_fd);
					libc::close(source_parent);
				}
				return *result;
			},
		};
		let result = link_no_replace(
			source_parent,
			source_name.as_c_str(),
			destination_parent,
			&destination_name,
		);
		let outcome = match result {
			Ok(())
				if published_matches_open_source(
					destination_parent,
					&destination_name,
					&source_stat,
				) =>
			{
				NativeExactUnlinkResult::success()
			},
			Ok(()) => NativeExactUnlinkResult::failure("destination_identity_changed"),
			Err(code) => NativeExactUnlinkResult::failure(code),
		};
		unsafe {
			libc::close(source_fd);
			libc::close(source_parent);
			libc::close(destination_parent);
		}
		outcome
	}

	fn link_no_replace(
		source_parent_fd: libc::c_int,
		source: &std::ffi::CStr,
		destination_parent_fd: libc::c_int,
		destination: &CString,
	) -> Result<(), &'static str> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut staged: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CStr are live; the initialized output struct is
		// writable.
		if unsafe {
			libc::fstatat(source_parent_fd, source.as_ptr(), &mut staged, libc::AT_SYMLINK_NOFOLLOW)
		} != 0
		{
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		if staged.st_mode & libc::S_IFMT != libc::S_IFREG {
			return Err("identity_mismatch");
		}
		// SAFETY: both parents own valid fds and both names are live NUL-terminated
		// strings for this syscall; flags are 0, so the source is linked as-is and
		// never resolved through a symlink.
		if unsafe {
			libc::linkat(
				source_parent_fd,
				source.as_ptr(),
				destination_parent_fd,
				destination.as_ptr(),
				0,
			)
		} == 0
		{
			return Ok(());
		}
		Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::EEXIST) => "already_exists",
			Some(libc::EXDEV) => "cross_device",
			// A filesystem without hard links reports EPERM for a valid request, which
			// is indistinguishable here from a denied one; both leave the destination
			// unpublished.
			Some(libc::EACCES | libc::EPERM) => "permission_denied",
			Some(libc::ENOENT) => "not_found",
			Some(libc::EINTR) => "interrupted",
			_ => "io_error",
		})
	}

	fn exact_regular_matches(
		parent_fd: libc::c_int,
		name: &CString,
		identity: &ExactFileIdentity,
	) -> Result<bool, &'static str> {
		// SAFETY: the retained parent descriptor and NUL-terminated name are live;
		// O_NOFOLLOW rejects a substituted symlink and O_NONBLOCK avoids blocking on
		// a substituted special file before fstat rejects it.
		let fd = unsafe {
			libc::openat(
				parent_fd,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let result = (|| {
			// SAFETY: zero is a valid initialized representation for fstat output.
			let mut opened: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: fd is live and opened is writable.
			if unsafe { libc::fstat(fd, &mut opened) } != 0 {
				return Err(security_code(&std::io::Error::last_os_error()));
			}
			if opened.st_mode & libc::S_IFMT != libc::S_IFREG {
				return Ok(false);
			}
			let digest = digest_fd(fd)?;
			// Linearize the pathname observation after descriptor hashing: the live name
			// must still resolve no-follow to the descriptor whose metadata and bytes were
			// checked above.
			// SAFETY: zero is a valid initialized representation for fstatat output.
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: parent_fd is live, name is NUL-terminated, and named is writable.
			if unsafe {
				libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW)
			} != 0
			{
				return Err(security_code(&std::io::Error::last_os_error()));
			}
			Ok(opened.st_dev as u64 == identity.dev
				&& opened.st_ino as u64 == identity.ino
				&& opened.st_size as u64 == identity.size
				&& stat_mtime_ns(&opened) == i128::from(identity.mtime_ns)
				&& (identity.allow_hard_link
					|| (opened.st_nlink == 1 && identity.nlink.is_none_or(|nlink| nlink == 1)))
				&& (identity.allow_hard_link
					|| identity
						.nlink
						.is_none_or(|nlink| nlink == opened.st_nlink as u64))
				&& identity.sha256.as_ref() == Some(&digest)
				&& named.st_mode & libc::S_IFMT == libc::S_IFREG
				&& named.st_dev == opened.st_dev
				&& named.st_ino == opened.st_ino)
		})();
		// SAFETY: this function owns fd exactly once.
		unsafe { libc::close(fd) };
		result
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the exact transaction retains all parent and file descriptors until terminal \
		          verification"
	)]
	pub(super) fn exact_replace_path(
		source_path: &Path,
		destination_path: &Path,
		expected_source: &ExactFileIdentity,
		expected_destination: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if source_path == destination_path {
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		if expected_source.directory
			|| expected_source.detach_only
			|| expected_destination.directory
			|| expected_destination.detach_only
			|| expected_source.parent_dev != expected_destination.parent_dev
			|| expected_source.parent_ino != expected_destination.parent_ino
		{
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		let (source_parent, source_name) = match open_parent_no_follow(source_path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		let (destination_parent, destination_name) = match open_parent_no_follow(destination_path) {
			Ok(value) => value,
			Err(result) => {
				unsafe { libc::close(source_parent) };
				return *result;
			},
		};
		if source_name == destination_name {
			unsafe {
				libc::close(source_parent);
				libc::close(destination_parent);
			}
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		let destination_lock = unsafe {
			libc::openat(
				destination_parent,
				destination_name.as_ptr(),
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
			)
		};
		if destination_lock < 0 || unsafe { libc::flock(destination_lock, libc::LOCK_EX) } != 0 {
			if destination_lock >= 0 {
				unsafe { libc::close(destination_lock) };
			}
			unsafe {
				libc::close(source_parent);
				libc::close(destination_parent);
			}
			return NativeExactUnlinkResult::failure("lock_failed");
		}
		let result = (|| {
			for (parent, identity) in
				[(source_parent, expected_source), (destination_parent, expected_destination)]
			{
				let Some((dev, ino)) = identity.parent_dev.zip(identity.parent_ino) else {
					return NativeExactUnlinkResult::failure("parent_mismatch");
				};
				let mut stat: libc::stat = unsafe { std::mem::zeroed() };
				if unsafe { libc::fstat(parent, &mut stat) } != 0
					|| stat.st_dev as u64 != dev
					|| stat.st_ino as u64 != ino
				{
					return NativeExactUnlinkResult::failure("parent_mismatch");
				}
			}
			if !matches!(exact_regular_matches(source_parent, &source_name, expected_source), Ok(true))
				|| !matches!(
					exact_regular_matches(destination_parent, &destination_name, expected_destination),
					Ok(true)
				) {
				return NativeExactUnlinkResult::failure("identity_mismatch");
			}
			let (source_fd, source_stat) = match open_publication_source(source_parent, &source_name) {
				Ok(value) => value,
				Err(code) => return NativeExactUnlinkResult::failure(code),
			};
			let private_name = CString::new(format!(
				".gjc-exact-replace-source-{:x}-{:x}-{:x}",
				expected_source.dev,
				expected_source.ino,
				std::process::id(),
			))
			.expect("private exact replacement name contains no NUL");
			let private_path = source_path.with_file_name(private_name.to_string_lossy().as_ref());
			let mut pinned_source_identity = expected_source.clone();
			pinned_source_identity.nlink = None;
			pinned_source_identity.allow_hard_link = true;
			let link_result =
				link_no_replace(source_parent, &source_name, source_parent, &private_name);
			let pinned = matches!(link_result, Ok(()))
				&& published_matches_open_source(source_parent, &private_name, &source_stat)
				&& matches!(
					exact_regular_matches(source_parent, &private_name, &pinned_source_identity),
					Ok(true)
				);
			unsafe { libc::close(source_fd) };
			if !pinned {
				if link_result.is_ok() {
					let _ = cleanup_substituted_publication(source_parent, &private_name, &private_path);
				}
				return NativeExactUnlinkResult::failure("identity_mismatch");
			}
			#[cfg(test)]
			pause_before_exchange_for_test();
			if let Err(code) =
				rename_exchange(source_parent, destination_parent, &private_name, &destination_name)
			{
				let _ = cleanup_substituted_publication(source_parent, &private_name, &private_path);
				return NativeExactUnlinkResult::failure(code);
			}
			#[cfg(test)]
			pause_exact_replace_after_exchange_for_test();
			if !matches!(
				exact_regular_matches(destination_parent, &destination_name, &pinned_source_identity),
				Ok(true)
			) || !matches!(
				exact_regular_matches(source_parent, &private_name, expected_destination),
				Ok(true)
			) {
				return NativeExactUnlinkResult::detached_failure_with_unknown(
					"identity_mismatch",
					private_path.to_string_lossy().into_owned(),
					destination_path.to_string_lossy().into_owned(),
				);
			}
			let mut source_cleanup_identity = expected_source.clone();
			source_cleanup_identity.nlink = None;
			source_cleanup_identity.allow_hard_link = true;
			source_cleanup_identity.quarantine_name = Some(format!(
				".gjc-exact-replace-source-cleanup-{:x}-{:x}",
				expected_source.ino,
				std::process::id(),
			));
			let source_cleanup = exact_unlink_at(
				source_parent,
				source_name.clone(),
				source_path,
				&source_cleanup_identity,
			);
			let mut destination_cleanup_identity = expected_destination.clone();
			destination_cleanup_identity.quarantine_name = Some(format!(
				".gjc-exact-replace-destination-{:x}-{:x}",
				expected_destination.ino,
				std::process::id(),
			));
			let destination_cleanup = exact_unlink_at(
				source_parent,
				private_name,
				&private_path,
				&destination_cleanup_identity,
			);
			let cleanup_accepted = |cleanup: &NativeExactUnlinkResult| {
				cleanup.ok
					|| (cleanup.code.as_deref() == Some("cleanup_pending")
						&& cleanup.payload_durable == Some(true)
						&& cleanup.retained_successor_path.is_none()
						&& cleanup.retained_unknown_path.is_none())
			};
			if !cleanup_accepted(&destination_cleanup) {
				return destination_cleanup.with_retained_successor_and_expected_detached(
					destination_path.to_string_lossy().into_owned(),
					private_path.to_string_lossy().into_owned(),
				);
			}
			if !cleanup_accepted(&source_cleanup) {
				return NativeExactUnlinkResult::retained_successor_failure(
					"identity_mismatch",
					destination_path.to_string_lossy().into_owned(),
				);
			}
			#[cfg(test)]
			pause_exact_replace_before_final_verify_for_test();
			if fsync_root_parent(source_parent).is_err() {
				return NativeExactUnlinkResult::retained_successor_failure(
					"durability_failed",
					destination_path.to_string_lossy().into_owned(),
				);
			}
			if !matches!(
				exact_regular_matches(destination_parent, &destination_name, expected_source),
				Ok(true)
			) {
				return NativeExactUnlinkResult::detached_failure_with_unknown(
					"identity_mismatch",
					source_path.to_string_lossy().into_owned(),
					destination_path.to_string_lossy().into_owned(),
				);
			}
			NativeExactUnlinkResult::success()
		})();
		unsafe {
			libc::close(destination_lock);
			libc::close(source_parent);
			libc::close(destination_parent);
		}
		result
	}
	pub(super) fn exact_restore(
		detached_path: &Path,
		original_path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if detached_path.parent() != original_path.parent() {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let (parent_fd, detached_name) = match open_parent_no_follow(detached_path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		if let Some((expected_parent_dev, expected_parent_ino)) =
			identity.parent_dev.zip(identity.parent_ino)
		{
			// SAFETY: zero is valid initialized storage for fstat output.
			let mut parent_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: parent_fd is the live retained parent descriptor.
			if unsafe { libc::fstat(parent_fd, &mut parent_stat) } != 0
				|| parent_stat.st_dev as u64 != expected_parent_dev
				|| parent_stat.st_ino as u64 != expected_parent_ino
			{
				// SAFETY: this branch owns parent_fd exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::failure("parent_mismatch");
			}
		}
		let Some(original_name_bytes) = original_path.file_name().map(|name| name.as_bytes()) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Ok(original_name) = CString::new(original_name_bytes) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		let expected_kind = if identity.directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut detached: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		let matches = unsafe {
			libc::fstatat(parent_fd, detached_name.as_ptr(), &mut detached, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && detached.st_mode & libc::S_IFMT == expected_kind
			&& detached.st_dev as u64 == identity.dev
			&& detached.st_ino as u64 == identity.ino
			&& detached.st_size as u64 == identity.size
			&& stat_mtime_ns(&detached) == i128::from(identity.mtime_ns)
			&& (identity.directory
				|| digest_openat(parent_fd, &detached_name).ok().as_ref() == identity.sha256.as_ref());
		if !matches {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory && detached.st_nlink != 1 {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		// Revalidate the name immediately before commit; rename_no_replace remains the
		// only namespace mutation and any observed substitution fails closed.
		// SAFETY: zero is valid initialized storage for fstatat output.
		let mut current: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: parent_fd and detached_name remain live for this no-follow probe.
		let current_matches = unsafe {
			libc::fstatat(parent_fd, detached_name.as_ptr(), &mut current, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && current.st_mode & libc::S_IFMT == expected_kind
			&& current.st_dev as u64 == identity.dev
			&& current.st_ino as u64 == identity.ino
			&& current.st_size as u64 == identity.size
			&& stat_mtime_ns(&current) == i128::from(identity.mtime_ns)
			&& (identity.directory
				|| digest_openat(parent_fd, &detached_name).ok().as_ref() == identity.sha256.as_ref());
		if !current_matches {
			// SAFETY: this branch owns the live parent descriptor exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		let placeholder =
			match create_exchange_placeholder(parent_fd, &original_name, identity.directory) {
				Ok(placeholder) => placeholder,
				Err(code) => {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(parent_fd) };
					return NativeExactUnlinkResult::failure(if code == "quarantine_collision" {
						"collision"
					} else {
						code
					});
				},
			};
		if let Err(code) = rename_exchange(parent_fd, parent_fd, &detached_name, &original_name) {
			let _ = remove_exchange_placeholder(parent_fd, &original_name, placeholder);
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(code);
		}
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut restored: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		let restored_matches = unsafe {
			libc::fstatat(parent_fd, original_name.as_ptr(), &mut restored, libc::AT_SYMLINK_NOFOLLOW)
		} == 0 && restored.st_mode & libc::S_IFMT == expected_kind
			&& restored.st_dev as u64 == identity.dev
			&& restored.st_ino as u64 == identity.ino
			&& restored.st_size as u64 == identity.size
			&& stat_mtime_ns(&restored) == i128::from(identity.mtime_ns)
			&& (identity.directory
				|| digest_openat(parent_fd, &original_name).ok().as_ref() == identity.sha256.as_ref());
		if !restored_matches {
			let restored =
				rename_no_replace(parent_fd, parent_fd, &original_name, &detached_name).is_ok();
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(if restored {
				"identity_mismatch"
			} else {
				"restore_failed"
			});
		}
		match remove_exchange_placeholder(parent_fd, &detached_name, placeholder) {
			ExchangePlaceholderRemoval::Removed => {},
			ExchangePlaceholderRemoval::RetainedMismatch(retained_name) => {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::retained_unknown_failure(
					"cleanup_pending",
					retained_name.to_string_lossy().into_owned(),
				);
			},
			ExchangePlaceholderRemoval::RetainedFailure(retained_name, _) => {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::retained_placeholder_failure(
					"cleanup_pending",
					retained_name.to_string_lossy().into_owned(),
				);
			},
			ExchangePlaceholderRemoval::Failed => {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return NativeExactUnlinkResult::retained_unknown_failure(
					"cleanup_pending",
					detached_path.to_string_lossy().into_owned(),
				);
			},
		}
		// SAFETY: this branch owns the live descriptor and closes it exactly once.
		unsafe { libc::close(parent_fd) };
		NativeExactUnlinkResult::success()
	}
	fn hex_digest(bytes: [u8; 32]) -> String {
		bytes.iter().fold(String::new(), |mut digest, byte| {
			write!(&mut digest, "{byte:02x}").expect("writing to String cannot fail");
			digest
		})
	}

	fn entry_from_stat(
		relative_path: String,
		stat: &libc::stat,
		kind: &str,
		digest: Option<String>,
	) -> NativeDirectoryTreeEntry {
		NativeDirectoryTreeEntry {
			relative_path,
			kind: kind.to_owned(),
			dev: stat.st_dev.to_string(),
			ino: stat.st_ino.to_string(),
			nlink: stat.st_nlink.to_string(),
			size: (stat.st_size as u64).to_string(),
			mtime_ns: stat_mtime_ns(stat).to_string(),
			ctime_ns: stat_ctime_ns(stat).to_string(),
			sha256: digest,
		}
	}

	fn clear_errno() {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: the platform accessor returns this thread's valid errno pointer.
		unsafe {
			*libc::__errno_location() = 0;
		}
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: the platform accessor returns this thread's valid errno pointer.
		unsafe {
			*libc::__error() = 0;
		}
	}

	fn current_errno() -> i32 {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		// SAFETY: the platform accessor returns this thread's valid errno pointer.
		unsafe {
			return *libc::__errno_location();
		}
		#[cfg(any(target_os = "macos", target_os = "ios"))]
		// SAFETY: the platform accessor returns this thread's valid errno pointer.
		unsafe {
			return *libc::__error();
		}
		#[allow(unreachable_code, reason = "every supported platform returns from its errno branch")]
		0
	}

	fn directory_names(fd: libc::c_int) -> Result<Vec<Vec<u8>>, &'static str> {
		let current = c".";
		// SAFETY: `fd` is live and `.` resolves the same directory with an independent
		// stream offset for each validation or scrub pass.
		let duplicate = unsafe {
			libc::openat(
				fd,
				current.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if duplicate < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		// SAFETY: ownership of the live duplicate transfers to DIR on success.
		let directory = unsafe { libc::fdopendir(duplicate) };
		if directory.is_null() {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(duplicate) };
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let mut names = Vec::new();
		loop {
			clear_errno();
			// SAFETY: the DIR pointer is live until its matching closedir call.
			let entry = unsafe { libc::readdir(directory) };
			if entry.is_null() {
				let errno = current_errno();
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::closedir(directory) };
				if errno == 0 {
					return Ok(names);
				}
				return Err(security_code(&std::io::Error::from_raw_os_error(errno)));
			}
			// SAFETY: readdir returned a live dirent with a NUL-terminated name.
			let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
			if name != b"." && name != b".." {
				names.push(name.to_vec());
			}
		}
	}

	fn snapshot_fd(
		fd: libc::c_int,
		relative: &str,
		entries: &mut Vec<NativeDirectoryTreeEntry>,
	) -> Result<(), &'static str> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut root: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor is live and the initialized output struct is writable.
		if unsafe { libc::fstat(fd, &mut root) } != 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		entries.push(entry_from_stat(relative.to_owned(), &root, "directory", None));
		let mut names = directory_names(fd)?;
		names.sort();
		for name_bytes in names {
			let name = CString::new(name_bytes.clone()).map_err(|_| "io_error")?;
			let name_text = std::str::from_utf8(&name_bytes).map_err(|_| "not_utf8")?;
			let child_relative = if relative.is_empty() {
				name_text.to_owned()
			} else {
				format!("{relative}/{name_text}")
			};
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: the descriptor and CString are live; the initialized output struct is
			// writable.
			if unsafe { libc::fstatat(fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
				return Err(security_code(&std::io::Error::last_os_error()));
			}
			match stat.st_mode & libc::S_IFMT {
				libc::S_IFREG => {
					if stat.st_nlink != 1 {
						return Err("hard_link_unsupported");
					}
					entries.push(entry_from_stat(
						child_relative,
						&stat,
						"file",
						Some(hex_digest(digest_openat(fd, &name).map_err(|_| "io_error")?)),
					));
				},
				libc::S_IFDIR => {
					// SAFETY: the live descriptor, where used, and NUL-terminated path remain
					// valid.
					let child = unsafe {
						libc::openat(
							fd,
							name.as_ptr(),
							libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
						)
					};
					if child < 0 {
						return Err(security_code(&std::io::Error::last_os_error()));
					}
					let result = snapshot_fd(child, &child_relative, entries);
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(child) };
					result?;
				},
				libc::S_IFLNK => return Err("reparse_point"),
				_ => return Err("unsupported_entry"),
			}
		}
		Ok(())
	}

	pub(super) fn snapshot_directory_tree(path: &Path) -> NativeDirectoryTreeResult {
		let (parent, name) = match open_parent_no_follow(path) {
			Ok(value) => value,
			Err(result) => {
				return NativeDirectoryTreeResult::failure(
					result.code.as_deref().unwrap_or("io_error"),
				);
			},
		};
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let fd = unsafe {
			libc::openat(
				parent,
				name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		// SAFETY: this branch owns the live descriptor and closes it exactly once.
		unsafe { libc::close(parent) };
		if fd < 0 {
			return NativeDirectoryTreeResult::failure(
				security_code(&std::io::Error::last_os_error()),
			);
		}
		let mut entries = Vec::new();
		let result = snapshot_fd(fd, "", &mut entries);
		// SAFETY: this branch owns the live descriptor and closes it exactly once.
		unsafe { libc::close(fd) };
		match result {
			Ok(()) => {
				let root = &entries[0];
				NativeDirectoryTreeResult::success(NativeDirectoryTreeSnapshot {
					root_dev: root.dev.clone(),
					root_ino: root.ino.clone(),
					entries,
				})
			},
			Err(code) => NativeDirectoryTreeResult::failure(code),
		}
	}

	fn expected_tree_entry<'a>(
		expected: &'a [NativeDirectoryTreeEntry],
		relative: &str,
	) -> Option<&'a NativeDirectoryTreeEntry> {
		expected
			.iter()
			.find(|entry| entry.relative_path == relative)
	}

	fn digest_fd(fd: libc::c_int) -> Result<[u8; 32], &'static str> {
		// SAFETY: `fd` is live; this function owns the returned duplicate.
		let duplicate = unsafe { libc::dup(fd) };
		if duplicate < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		// SAFETY: ownership of the live duplicate transfers to `File` exactly once.
		let mut file = unsafe { File::from_raw_fd(duplicate) };
		digest_reader(&mut file).map_err(|_| "io_error")
	}

	fn open_tree_entry(
		parent_fd: libc::c_int,
		name: &CString,
		expected: &NativeDirectoryTreeEntry,
		allow_scrubbed: bool,
	) -> Result<libc::c_int, &'static str> {
		let directory = expected.kind == "directory";
		let flags = libc::O_RDONLY
			| libc::O_CLOEXEC
			| libc::O_NOFOLLOW
			| if directory { libc::O_DIRECTORY } else { 0 };
		// SAFETY: the parent descriptor and NUL-terminated component are live.
		let fd = unsafe { libc::openat(parent_fd, name.as_ptr(), flags) };
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `fd` is live and `stat` is writable.
		if unsafe { libc::fstat(fd, &mut stat) } != 0 {
			// SAFETY: this branch owns `fd` exactly once.
			unsafe { libc::close(fd) };
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		if !directory && stat.st_nlink != 1 {
			// SAFETY: this branch owns `fd` exactly once.
			unsafe { libc::close(fd) };
			return Err("hard_link_unsupported");
		}
		let expected_kind = if directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		let identity_matches = stat.st_mode & libc::S_IFMT == expected_kind
			&& stat.st_dev as u64 == expected.dev.parse().ok().unwrap_or(u64::MAX)
			&& stat.st_ino as u64 == expected.ino.parse().ok().unwrap_or(u64::MAX);
		let content_matches = if directory {
			expected.sha256.is_none()
		} else {
			let digest = match digest_fd(fd) {
				Ok(digest) => digest,
				Err(code) => {
					// SAFETY: this branch owns `fd` exactly once.
					unsafe { libc::close(fd) };
					return Err(code);
				},
			};
			let original = stat.st_size as u64 == expected.size.parse().ok().unwrap_or(u64::MAX)
				&& stat_mtime_ns(&stat).to_string() == expected.mtime_ns
				&& expected.sha256.as_deref() == Some(hex_digest(digest).as_str());
			let scrubbed = allow_scrubbed && stat.st_size == 0 && digest == sha256(b"");
			original || scrubbed
		};
		if !identity_matches || !content_matches {
			// SAFETY: this branch owns `fd` exactly once.
			unsafe { libc::close(fd) };
			return Err("identity_mismatch");
		}
		Ok(fd)
	}

	fn open_tree_entry_unverified(
		parent_fd: libc::c_int,
		name: &CString,
		directory: bool,
	) -> Result<libc::c_int, &'static str> {
		let flags = libc::O_RDONLY
			| libc::O_CLOEXEC
			| libc::O_NOFOLLOW
			| if directory { libc::O_DIRECTORY } else { 0 };
		// SAFETY: the parent descriptor and NUL-terminated component are live.
		let fd = unsafe { libc::openat(parent_fd, name.as_ptr(), flags) };
		if fd < 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		Ok(fd)
	}

	/// Each child quarantine name is a bounded deterministic digest of the
	/// expected durable identity. This keeps quarantine components portable at
	/// `NAME_MAX` while allowing replay to map only an expected direct child
	/// back from its retained name.
	fn tree_quarantine_name(expected: &NativeDirectoryTreeEntry) -> CString {
		let mut material = expected.relative_path.as_bytes().to_vec();
		material.push(0);
		material.extend_from_slice(expected.dev.as_bytes());
		material.push(0);
		material.extend_from_slice(expected.ino.as_bytes());
		CString::new(format!(".pi-tree-detached-{}", hex_digest(sha256(&material))))
			.expect("literal prefix and hexadecimal digest contain no NUL")
	}

	fn expected_quarantined_tree_entry<'a>(
		expected: &'a [NativeDirectoryTreeEntry],
		relative: &str,
		name: &[u8],
	) -> Option<&'a NativeDirectoryTreeEntry> {
		let mut matching = expected.iter().filter(|entry| {
			let parent_matches = entry
				.relative_path
				.rsplit_once('/')
				.map_or(relative.is_empty(), |(parent, _)| parent == relative);
			!entry.relative_path.is_empty()
				&& parent_matches
				&& tree_quarantine_name(entry).as_bytes() == name
		});
		let entry = matching.next()?;
		matching.next().is_none().then_some(entry)
	}

	fn scrub_tree_fd(
		fd: libc::c_int,
		relative: &str,
		expected: &[NativeDirectoryTreeEntry],
	) -> Result<(), &'static str> {
		let mut names = directory_names(fd)?;
		names.sort();
		for name_bytes in names {
			let physical = CString::new(name_bytes.clone()).map_err(|_| "io_error")?;
			let direct_name = std::str::from_utf8(&name_bytes).ok();
			let direct_relative = direct_name.map(|name| {
				if relative.is_empty() {
					name.to_owned()
				} else {
					format!("{relative}/{name}")
				}
			});
			let expected_direct = direct_relative
				.as_deref()
				.and_then(|candidate| expected_tree_entry(expected, candidate));
			let expected_quarantined =
				expected_quarantined_tree_entry(expected, relative, &name_bytes);
			let (expected_child, already_quarantined) = match (expected_direct, expected_quarantined) {
				(Some(entry), None) => (entry, false),
				(None, Some(entry)) => (entry, true),
				_ => return Err("identity_mismatch"),
			};
			let child = open_tree_entry(fd, &physical, expected_child, true)?;
			let retained_name = if already_quarantined {
				tree_quarantine_name(expected_child)
			} else {
				physical.clone()
			};
			#[cfg(test)]
			if !already_quarantined {
				pause_before_tree_child_rename_for_test();
			}
			// Reopen the current retained name and compare it to the authorized
			// descriptor before recursive or writable access. Children stay under
			// their direct names inside the already-detached root; no mutable child
			// pathname is renamed or unlinked by this scrubber.
			let retained = match open_tree_entry_unverified(
				fd,
				&retained_name,
				expected_child.kind == "directory",
			) {
				Ok(retained) => retained,
				Err(code) => {
					// SAFETY: this branch owns `child` exactly once.
					unsafe { libc::close(child) };
					return Err(code);
				},
			};
			// SAFETY: zero is a valid initialized representation for these output structs.
			let mut child_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut retained_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: both descriptors are live and both output structs are writable.
			let same_object = unsafe { libc::fstat(child, &mut child_stat) } == 0
				&& unsafe { libc::fstat(retained, &mut retained_stat) } == 0
				&& child_stat.st_dev == retained_stat.st_dev
				&& child_stat.st_ino == retained_stat.st_ino;
			// SAFETY: this branch owns `retained` exactly once.
			unsafe { libc::close(retained) };
			if !same_object {
				// SAFETY: this branch owns `child` exactly once.
				unsafe { libc::close(child) };
				return Err("identity_mismatch");
			}
			let result = if expected_child.kind == "directory" {
				scrub_tree_fd(child, &expected_child.relative_path, expected)
			} else if child_stat.st_size == 0
				&& digest_fd(child).is_ok_and(|digest| digest == sha256(b""))
			{
				// SAFETY: `child` is a live descriptor authorized by the tree snapshot.
				if unsafe { libc::fsync(child) } != 0 {
					Err(security_code(&std::io::Error::last_os_error()))
				} else {
					Ok(())
				}
			} else {
				// Reopen writable, then revalidate identity and link count immediately
				// before any permission or payload mutation. A hard link created after
				// snapshot/open must preserve every alias unchanged.
				// SAFETY: `fd` is a live directory descriptor and `retained_name` is a
				// NUL-terminated child name retained beneath it.
				let writable = unsafe {
					libc::openat(
						fd,
						retained_name.as_ptr(),
						libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					)
				};
				if writable < 0 {
					Err(security_code(&std::io::Error::last_os_error()))
				} else {
					// SAFETY: zero is a valid initialized representation for this output struct.
					let mut writable_stat: libc::stat = unsafe { std::mem::zeroed() };
					// SAFETY: `writable` is live and `writable_stat` is writable.
					let writable_matches = unsafe { libc::fstat(writable, &mut writable_stat) } == 0
						&& writable_stat.st_dev == child_stat.st_dev
						&& writable_stat.st_ino == child_stat.st_ino;
					let outcome = if !writable_matches {
						Err("identity_mismatch")
					} else if writable_stat.st_nlink != 1 {
						Err("hard_link_unsupported")
					} else {
						// SAFETY: zero is a valid initialized representation for this output struct.
						let mut truncate_stat: libc::stat = unsafe { std::mem::zeroed() };
						// SAFETY: `writable` is live and `truncate_stat` is writable.
						let truncate_matches = unsafe { libc::fstat(writable, &mut truncate_stat) } == 0
							&& truncate_stat.st_dev == child_stat.st_dev
							&& truncate_stat.st_ino == child_stat.st_ino;
						if !truncate_matches {
							Err("identity_mismatch")
						} else if truncate_stat.st_nlink != 1 {
							Err("hard_link_unsupported")
						} else {
							#[cfg(test)]
							pause_after_tree_file_link_check_for_test();
							// Recheck after the final test/race seam immediately before mutation.
							// SAFETY: zero is a valid initialized representation for this output struct.
							let mut commit_stat: libc::stat = unsafe { std::mem::zeroed() };
							// SAFETY: `writable` is live and `commit_stat` is writable.
							let commit_matches = unsafe { libc::fstat(writable, &mut commit_stat) } == 0
								&& commit_stat.st_dev == child_stat.st_dev
								&& commit_stat.st_ino == child_stat.st_ino
								&& commit_stat.st_size as u64
									== expected_child.size.parse().ok().unwrap_or(u64::MAX)
								&& stat_mtime_ns(&commit_stat)
									== expected_child.mtime_ns.parse().ok().unwrap_or(i128::MIN)
								&& digest_fd(writable).ok().is_some_and(|digest| {
									expected_child
										.sha256
										.as_deref()
										.is_some_and(|expected| hex_digest(digest) == expected)
								});
							if !commit_matches {
								Err("identity_mismatch")
							} else if commit_stat.st_nlink != 1 {
								Err("hard_link_unsupported")
							} else {
								// SAFETY: `writable` is the live, revalidated, single-link file descriptor.
								let truncate_result = unsafe { libc::ftruncate(writable, 0) };
								if truncate_result != 0 {
									Err(security_code(&std::io::Error::last_os_error()))
								} else {
									// SAFETY: `writable` remains live after successful truncation.
									if unsafe { libc::fsync(writable) } != 0 {
										Err(security_code(&std::io::Error::last_os_error()))
									} else {
										Ok(())
									}
								}
							}
						}
					};
					// SAFETY: this branch owns `writable` exactly once.
					unsafe { libc::close(writable) };
					outcome
				}
			};
			// SAFETY: this branch owns `child` exactly once.
			unsafe { libc::close(child) };
			result?;
		}
		// SAFETY: `fd` is a live directory descriptor.
		if unsafe { libc::fsync(fd) } != 0 {
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		Ok(())
	}

	/// Validate the retained tree before atomically detaching its root. Every
	/// entry still present must map uniquely to its durable logical identity,
	/// including deterministic names retained by older attempts.
	fn validate_tree_fd(
		fd: libc::c_int,
		relative: &str,
		expected: &[NativeDirectoryTreeEntry],
	) -> Result<(), &'static str> {
		let mut names = directory_names(fd)?;
		names.sort();
		let mut seen = std::collections::BTreeSet::new();
		for name_bytes in names {
			let physical = CString::new(name_bytes.clone()).map_err(|_| "io_error")?;
			let direct_name = std::str::from_utf8(&name_bytes).ok();
			let direct_relative = direct_name.map(|name| {
				if relative.is_empty() {
					name.to_owned()
				} else {
					format!("{relative}/{name}")
				}
			});
			let expected_direct = direct_relative
				.as_deref()
				.and_then(|candidate| expected_tree_entry(expected, candidate));
			let expected_quarantined =
				expected_quarantined_tree_entry(expected, relative, &name_bytes);
			let (logical_bytes, expected_child, _quarantined) =
				match (expected_direct, expected_quarantined) {
					(Some(entry), None) => (name_bytes.clone(), entry, false),
					(None, Some(entry)) => (
						entry.relative_path.rsplit_once('/').map_or_else(
							|| entry.relative_path.as_bytes().to_vec(),
							|(_, name)| name.as_bytes().to_vec(),
						),
						entry,
						true,
					),
					_ => return Err("identity_mismatch"),
				};
			let logical_name = std::str::from_utf8(&logical_bytes).map_err(|_| "not_utf8")?;
			let child_relative = if relative.is_empty() {
				logical_name.to_owned()
			} else {
				format!("{relative}/{logical_name}")
			};
			if !seen.insert(child_relative.clone())
				|| expected_tree_entry(expected, &child_relative) != Some(expected_child)
			{
				return Err("identity_mismatch");
			}
			let child = open_tree_entry(fd, &physical, expected_child, true)?;
			let result = if expected_child.kind == "directory" {
				validate_tree_fd(child, &child_relative, expected)
			} else {
				Ok(())
			};
			// SAFETY: this branch owns `child` exactly once.
			unsafe { libc::close(child) };
			result?;
		}
		Ok(())
	}

	pub(super) fn exact_remove_directory_tree(
		path: &Path,
		expected: &NativeDirectoryTreeSnapshot,
		expected_parent: Option<(u64, u64)>,
	) -> NativeExactUnlinkResult {
		let planned_path = path.to_string_lossy().into_owned();
		let final_path = format!("{planned_path}.removing");
		let (parent, name) = match open_parent_no_follow(path) {
			Ok(value) => value,
			Err(result) => return *result,
		};
		if let Some((expected_dev, expected_ino)) = expected_parent {
			// SAFETY: zero is valid initialized storage for `fstat` output.
			let mut parent_stat: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: `parent` is the retained no-follow parent descriptor.
			if unsafe { libc::fstat(parent, &mut parent_stat) } != 0
				|| parent_stat.st_dev as u64 != expected_dev
				|| parent_stat.st_ino as u64 != expected_ino
			{
				// SAFETY: this branch owns `parent` exactly once.
				unsafe { libc::close(parent) };
				return NativeExactUnlinkResult::failure("parent_mismatch");
			}
		}
		let mut final_bytes = name.as_bytes().to_vec();
		final_bytes.extend_from_slice(b".removing");
		let Ok(final_name) = CString::new(final_bytes) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		// A crash after the final no-replace rename is replayed from the single,
		// caller-derivable sibling. This is not a search fallback: it is the only
		// alternate retained authority for this exact planned root.
		let input_is_final = name.as_bytes().ends_with(b".removing");
		let (fd, root_name, retained_path, already_final) = {
			// SAFETY: the live descriptor, where used, and NUL-terminated path remain
			// valid.
			let fd = unsafe {
				libc::openat(
					parent,
					name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			if fd >= 0 {
				(fd, &name, planned_path.clone(), input_is_final)
			} else if !input_is_final
				&& std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
			{
				// SAFETY: the live descriptor, where used, and NUL-terminated path remain
				// valid.
				let fd = unsafe {
					libc::openat(
						parent,
						final_name.as_ptr(),
						libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					)
				};
				if fd < 0 {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(parent) };
					return NativeExactUnlinkResult::failure(security_code(
						&std::io::Error::last_os_error(),
					));
				}
				(fd, &final_name, final_path.clone(), true)
			} else {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent) };
				return NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				));
			}
		};
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut root: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor is live and the initialized output struct is writable.
		let root_matches = unsafe { libc::fstat(fd, &mut root) } == 0
			&& root.st_dev as u64 == expected.root_dev.parse().ok().unwrap_or(u64::MAX)
			&& root.st_ino as u64 == expected.root_ino.parse().ok().unwrap_or(u64::MAX);
		if !root_matches {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe {
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure("identity_mismatch", retained_path);
		}
		if let Err(code) = validate_tree_fd(fd, "", &expected.entries) {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe {
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure(code, retained_path);
		}
		if expected_tree_entry(&expected.entries, "").is_none() {
			// SAFETY: this branch owns the live descriptors and closes each exactly once.
			unsafe {
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure("identity_mismatch", retained_path);
		}
		#[cfg(test)]
		pause_after_tree_validation_for_test();
		if !already_final {
			// Reopen the current source name after the race seam. A successor cannot
			// become the detached cleanup target merely because it occupies the same path.
			// SAFETY: `parent` is live and `root_name` is a NUL-terminated direct child.
			let current_fd = unsafe {
				libc::openat(
					parent,
					root_name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
				)
			};
			if current_fd < 0 {
				// SAFETY: this branch owns the live descriptors and closes each exactly once.
				unsafe {
					libc::close(fd);
					libc::close(parent);
				}
				return NativeExactUnlinkResult::detached_failure("identity_mismatch", planned_path);
			}
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut current_root: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: `current_fd` is live and `current_root` is writable.
			let current_valid = unsafe { libc::fstat(current_fd, &mut current_root) } == 0
				&& current_root.st_dev == root.st_dev
				&& current_root.st_ino == root.st_ino;
			// SAFETY: this branch owns `current_fd` exactly once.
			unsafe { libc::close(current_fd) };
			if !current_valid {
				// SAFETY: this branch owns the live descriptors and closes each exactly once.
				unsafe {
					libc::close(fd);
					libc::close(parent);
				}
				return NativeExactUnlinkResult::detached_failure("identity_mismatch", planned_path);
			}
		}
		let detached_retained_path = if already_final {
			retained_path
		} else {
			#[cfg(test)]
			pause_before_tree_root_rename_for_test();
			match rename_no_replace(parent, parent, root_name, &final_name).or_else(|code| {
				if matches!(code, "invalid_request" | "atomic_unavailable") {
					rename_directory_no_replace_at(parent, parent, root_name, &final_name)
				} else {
					Err(code)
				}
			}) {
				Ok(()) => final_path,
				Err(code) => {
					// SAFETY: this branch owns the live descriptors and closes each exactly once.
					unsafe {
						libc::close(fd);
						libc::close(parent);
					}
					return NativeExactUnlinkResult::detached_failure(code, planned_path);
				},
			}
		};
		if let Err(code) = fsync_root_parent(parent) {
			// SAFETY: this branch owns the live descriptors and closes each exactly once.
			unsafe {
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure(code, detached_retained_path);
		}
		let detached_name = if already_final {
			root_name
		} else {
			&final_name
		};
		// Reopen and revalidate the detached retained name after the race seam.
		// A substituted root fails before any recursive or writable mutation.
		// SAFETY: `parent` is live and `detached_name` is the NUL-terminated retained
		// tree name validated above.
		let detached_fd = unsafe {
			libc::openat(
				parent,
				detached_name.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if detached_fd < 0 {
			// SAFETY: this branch owns the original root descriptor exactly once.
			unsafe { libc::close(fd) };
			if !already_final {
				let (code, successor_path) =
					match rename_no_replace(parent, parent, detached_name, root_name) {
						Ok(()) => (
							if fsync_root_parent(parent).is_ok() {
								"identity_mismatch"
							} else {
								"io_error"
							},
							planned_path,
						),
						Err(_) => ("identity_mismatch", detached_retained_path),
					};
				// SAFETY: this branch owns the live parent descriptor exactly once.
				unsafe { libc::close(parent) };
				return NativeExactUnlinkResult::retained_successor_failure(code, successor_path);
			}
			// SAFETY: this branch owns the live parent descriptor exactly once.
			unsafe { libc::close(parent) };
			return NativeExactUnlinkResult::detached_failure(
				"cleanup_pending",
				detached_retained_path,
			);
		}
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut detached_root: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `detached_fd` is live and `detached_root` is writable.
		let detached_valid = unsafe { libc::fstat(detached_fd, &mut detached_root) } == 0
			&& detached_root.st_dev as u64 == expected.root_dev.parse().ok().unwrap_or(u64::MAX)
			&& detached_root.st_ino as u64 == expected.root_ino.parse().ok().unwrap_or(u64::MAX);
		if !detached_valid {
			// SAFETY: this branch owns the retained root descriptors exactly once.
			unsafe {
				libc::close(detached_fd);
				libc::close(fd);
			}
			if !already_final {
				let (code, successor_path) =
					match rename_no_replace(parent, parent, detached_name, root_name) {
						Ok(()) => (
							if fsync_root_parent(parent).is_ok() {
								"identity_mismatch"
							} else {
								"io_error"
							},
							planned_path,
						),
						Err(_) => ("identity_mismatch", detached_retained_path),
					};
				// SAFETY: this branch owns the live parent descriptor exactly once.
				unsafe { libc::close(parent) };
				return NativeExactUnlinkResult::retained_successor_failure(code, successor_path);
			}
			// SAFETY: this branch owns the live parent descriptor exactly once.
			unsafe { libc::close(parent) };
			return NativeExactUnlinkResult::detached_failure(
				"identity_mismatch",
				detached_retained_path,
			);
		}
		if let Err(code) = validate_tree_fd(detached_fd, "", &expected.entries)
			.and_then(|()| scrub_tree_fd(detached_fd, "", &expected.entries))
			.and_then(|()| validate_tree_fd(detached_fd, "", &expected.entries))
		{
			// SAFETY: this branch owns the live descriptors and closes each exactly once.
			unsafe {
				libc::close(detached_fd);
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure(code, detached_retained_path);
		}
		#[cfg(test)]
		pause_after_tree_scrub_for_test();
		// Rebind the durable receipt to the retained namespace after payload scrub.
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut retained_namespace: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `parent` is live, `detached_name` is NUL-terminated, and the output
		// is writable.
		let retained_status = unsafe {
			libc::fstatat(
				parent,
				detached_name.as_ptr(),
				&mut retained_namespace,
				libc::AT_SYMLINK_NOFOLLOW,
			)
		};
		let retained_matches = retained_status == 0
			&& retained_namespace.st_mode & libc::S_IFMT == libc::S_IFDIR
			&& retained_namespace.st_dev as u64 == expected.root_dev.parse().ok().unwrap_or(u64::MAX)
			&& retained_namespace.st_ino as u64 == expected.root_ino.parse().ok().unwrap_or(u64::MAX);
		if !retained_matches {
			// SAFETY: this branch owns the live descriptors and closes each exactly once.
			unsafe {
				libc::close(detached_fd);
				libc::close(fd);
				libc::close(parent);
			}
			return if retained_status == 0 {
				NativeExactUnlinkResult::retained_successor_failure(
					"identity_mismatch",
					detached_retained_path,
				)
			} else {
				NativeExactUnlinkResult::detached_failure("identity_mismatch", detached_retained_path)
			};
		}
		if let Err(code) = fsync_root_parent(parent) {
			// SAFETY: this branch owns the live descriptors and closes each exactly once.
			unsafe {
				libc::close(detached_fd);
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure(code, detached_retained_path);
		}
		// POSIX cannot bind namespace unlink to a verified descriptor. The fallback
		// therefore keeps the caller-authorized retained namespace and destroys every
		// authorized file payload only after direct-name descriptor revalidation.
		// Replays accept the same identities in original or scrubbed form; publisher
		// successors are never renamed, unlinked, or truncated.
		// SAFETY: this branch owns the live descriptors and closes each exactly once.
		unsafe {
			libc::close(detached_fd);
			libc::close(fd);
			libc::close(parent);
		}
		NativeExactUnlinkResult::detached_failure_with_durable_payload(
			"cleanup_pending",
			detached_retained_path,
		)
	}
}

#[cfg(windows)]
mod platform {
	#[cfg(test)]
	use std::sync::atomic::AtomicBool;
	#[cfg(test)]
	use std::sync::{Mutex, OnceLock, mpsc};
	use std::{
		ffi::{OsStr, OsString, c_void},
		mem::{align_of, size_of},
		os::windows::ffi::{OsStrExt, OsStringExt},
		path::{Component, Path, PathBuf},
		ptr::{null, null_mut},
		sync::atomic::{AtomicU64, Ordering},
	};

	use sha2::{Digest, Sha256};
	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, DUPLICATE_SAME_ACCESS, DuplicateHandle, ERROR_FILE_NOT_FOUND,
			ERROR_PATH_NOT_FOUND, ERROR_SHARING_VIOLATION, GENERIC_ALL, GetLastError, HANDLE,
			INVALID_HANDLE_VALUE, LocalFree,
		},
		Security::{
			ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, ACL_SIZE_INFORMATION,
			AclSizeInformation, AddAccessAllowedAceEx,
			Authorization::{GetSecurityInfo, SE_FILE_OBJECT, SetSecurityInfo},
			DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetAclInformation, GetLengthSid,
			GetTokenInformation, InitializeAcl, IsValidSid, OWNER_SECURITY_INFORMATION,
			PROTECTED_DACL_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
		},
		Storage::FileSystem::{
			BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ALL_ACCESS, FILE_ATTRIBUTE_DIRECTORY,
			FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT,
			FILE_BASIC_INFO, FILE_BEGIN, FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS,
			FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE,
			FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA,
			FileBasicInfo, FileDispositionInfo, FlushFileBuffers, GetFileInformationByHandle,
			GetFinalPathNameByHandleW, OPEN_EXISTING, READ_CONTROL, ReadFile, SetEndOfFile,
			SetFileInformationByHandle, SetFilePointerEx, VOLUME_NAME_GUID, WRITE_DAC, WRITE_OWNER,
			WriteFile,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	use super::{
		EXACT_REPLACE_DESTINATION_OPEN_RETRY_DELAY_MS, EXACT_REPLACE_DESTINATION_OPEN_RETRY_LIMIT,
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeEntry,
		NativeDirectoryTreeResult, NativeDirectoryTreeSnapshot, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, NativeSecureSkillWriteResult, STATUS_INVALID_PARAMETER,
		STATUS_SHARING_VIOLATION, is_retryable_exact_replace_status, native_windows_error_code,
		open_with_transient_retry, sha256,
	};

	type UvGetOsfhandle = unsafe extern "C" fn(fd: i32) -> isize;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn GetModuleHandleW(module_name: *const u16) -> *mut c_void;
		fn GetProcAddress(module: *mut c_void, procedure_name: *const u8) -> *mut c_void;
	}

	// Test-only fault injection for the exact-replace destination open retry:
	// the next N destination opens report a synthetic STATUS_SHARING_VIOLATION
	// before the real NtCreateFile runs, letting Windows tests exercise the
	// bounded retry loop without racing a real concurrent holder. Mirrors the
	// rename_exchange injection in the unix platform module.
	#[cfg(test)]
	thread_local! {
		static EXACT_REPLACE_DESTINATION_OPEN_SHARING_VIOLATION_INJECT: std::cell::Cell<u32> =
			const { std::cell::Cell::new(0) };
	}

	#[cfg(test)]
	static SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static SECURE_SKILL_WRITE_AFTER_RENAME_HOOK: OnceLock<
		Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
	> = OnceLock::new();
	#[cfg(test)]
	static FAIL_SECURE_SKILL_CLEANUP: AtomicBool = AtomicBool::new(false);
	static NEXT_SECURE_SKILL_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	#[cfg(test)]
	pub(super) fn inject_exact_replace_destination_open_sharing_violations(count: u32) {
		EXACT_REPLACE_DESTINATION_OPEN_SHARING_VIOLATION_INJECT.with(|target| target.set(count));
	}

	#[cfg(test)]
	fn take_injected_exact_replace_destination_open_sharing_violation() -> bool {
		EXACT_REPLACE_DESTINATION_OPEN_SHARING_VIOLATION_INJECT.with(|target| {
			let current = target.get();
			if current == 0 {
				return false;
			}
			target.set(current - 1);
			true
		})
	}

	#[cfg(not(test))]
	const fn take_injected_exact_replace_destination_open_sharing_violation() -> bool {
		false
	}

	#[cfg(test)]
	pub(super) fn set_secure_skill_write_before_rename_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn set_secure_skill_write_after_rename_hook(
		hook: Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>,
	) {
		*SECURE_SKILL_WRITE_AFTER_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner()) = hook;
	}

	#[cfg(test)]
	pub(super) fn inject_secure_skill_cleanup_failure(enabled: bool) {
		FAIL_SECURE_SKILL_CLEANUP.store(enabled, Ordering::Relaxed);
	}

	#[cfg(test)]
	fn pause_secure_skill_write_before_rename_for_test() {
		if let Some((entered, resume)) = SECURE_SKILL_WRITE_BEFORE_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered.send(()).expect("secure skill write hook receiver");
			resume.recv().expect("secure skill write hook resume");
		}
	}

	#[cfg(test)]
	fn pause_secure_skill_write_after_rename_for_test() {
		if let Some((entered, resume)) = SECURE_SKILL_WRITE_AFTER_RENAME_HOOK
			.get_or_init(|| Mutex::new(None))
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner())
			.take()
		{
			entered
				.send(())
				.expect("secure skill write post-rename hook receiver");
			resume
				.recv()
				.expect("secure skill write post-rename hook resume");
		}
	}

	const SECURITY_OWNER_DACL: u32 = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
	const SECURITY_OWNER_DACL_PROTECTED: u32 =
		SECURITY_OWNER_DACL | PROTECTED_DACL_SECURITY_INFORMATION;
	const SECURITY_DACL_PROTECTED: u32 =
		DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION;

	const FILE_RENAME_INFORMATION_CLASS: i32 = 10;

	#[repr(C)]
	struct HandleRenameInformation {
		replace_if_exists: u8,
		root_directory:    HANDLE,
		file_name_length:  u32,
		file_name:         [u16; 1],
	}

	fn wide(path: &Path) -> Vec<u16> {
		path.as_os_str().encode_wide().chain(Some(0)).collect()
	}

	fn is_network_path(path: &Path) -> bool {
		let value = path.as_os_str().to_string_lossy();
		if value.starts_with(r"\\?\UNC\") {
			true
		} else if value.starts_with(r"\\?\") {
			false
		} else {
			value.starts_with(r"\\")
		}
	}

	fn last_error_code() -> &'static str {
		match unsafe { GetLastError() } {
			ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "not_found",
			ERROR_SHARING_VIOLATION => "sharing_violation",
			_ => "io_error",
		}
	}

	fn open_path(path: &Path, reparse: bool, desired_access: u32) -> Result<HANDLE, &'static str> {
		if is_network_path(path) {
			return Err("network_unsupported");
		}
		let wide = wide(path);
		let flags = FILE_FLAG_BACKUP_SEMANTICS
			| if reparse {
				FILE_FLAG_OPEN_REPARSE_POINT
			} else {
				0
			};
		let handle = unsafe {
			CreateFileW(
				wide.as_ptr(),
				desired_access,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				null(),
				OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL | flags,
				null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			return Err(last_error_code());
		}
		Ok(handle)
	}

	fn handle_attributes(handle: HANDLE) -> Result<u32, &'static str> {
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			return Err(last_error_code());
		}
		Ok(information.dwFileAttributes)
	}

	fn final_path(handle: HANDLE) -> Result<String, &'static str> {
		let mut buffer = vec![0u16; 32_768];
		let length = unsafe {
			GetFinalPathNameByHandleW(
				handle,
				buffer.as_mut_ptr(),
				buffer.len() as u32,
				VOLUME_NAME_GUID,
			)
		};
		if length == 0 {
			// SMB mapped drives can open normally yet reject VOLUME_NAME_GUID with
			// ERROR_PATH_NOT_FOUND. Their final identity cannot be a local volume.
			return Err(match unsafe { GetLastError() } {
				ERROR_PATH_NOT_FOUND => "network_unsupported",
				_ => "identity_unavailable",
			});
		}
		if length as usize >= buffer.len() {
			return Err("identity_unavailable");
		}
		let value =
			String::from_utf16(&buffer[..length as usize]).map_err(|_| "identity_unavailable")?;
		if value.starts_with(r"\\?\UNC\") {
			return Err("network_unsupported");
		}
		if !value.starts_with(r"\\?\Volume{") {
			return Err("identity_unavailable");
		}
		Ok(value)
	}

	pub(super) fn canonical_existing_directory_identity(
		path: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		let handle = match open_path(path, false, FILE_READ_ATTRIBUTES) {
			Ok(handle) => handle,
			Err(code) => return NativeCanonicalDirectoryIdentity::failure(code),
		};
		let attributes = match handle_attributes(handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe {
					CloseHandle(handle);
				}
				return NativeCanonicalDirectoryIdentity::failure(code);
			},
		};
		if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
			unsafe {
				CloseHandle(handle);
			}
			return NativeCanonicalDirectoryIdentity::failure("not_directory");
		}
		let result = final_path(handle)
			.map(|canonical_path| NativeCanonicalDirectoryIdentity::success("win32", canonical_path))
			.unwrap_or_else(NativeCanonicalDirectoryIdentity::failure);
		unsafe {
			CloseHandle(handle);
		}
		result
	}

	#[repr(C)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         *mut u16,
	}

	#[repr(C)]
	struct ObjectAttributes {
		length: u32,
		root_directory: HANDLE,
		object_name: *mut UnicodeString,
		attributes: u32,
		security_descriptor: *mut c_void,
		security_quality_of_service: *mut c_void,
	}

	#[repr(C)]
	struct IoStatusBlock {
		status:      i32,
		information: usize,
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtCreateFile(
			file_handle: *mut HANDLE,
			desired_access: u32,
			object_attributes: *mut ObjectAttributes,
			io_status_block: *mut IoStatusBlock,
			allocation_size: *mut i64,
			file_attributes: u32,
			share_access: u32,
			create_disposition: u32,
			create_options: u32,
			ea_buffer: *mut c_void,
			ea_length: u32,
		) -> i32;

		fn NtSetInformationFile(
			file_handle: HANDLE,
			io_status_block: *mut IoStatusBlock,
			file_information: *mut c_void,
			length: u32,
			file_information_class: i32,
		) -> i32;

		fn NtQueryDirectoryFile(
			file_handle: HANDLE,
			event: HANDLE,
			apc_routine: *mut c_void,
			apc_context: *mut c_void,
			io_status_block: *mut IoStatusBlock,
			file_information: *mut c_void,
			length: u32,
			file_information_class: u32,
			return_single_entry: u8,
			file_name: *mut UnicodeString,
			restart_scan: u8,
		) -> i32;
	}

	const FILE_ID_BOTH_DIRECTORY_INFORMATION: u32 = 37;
	const STATUS_NO_MORE_FILES: i32 = 0x8000_0006u32 as i32;
	const STATUS_BUFFER_OVERFLOW: i32 = 0x8000_0005u32 as i32;

	#[repr(C)]
	struct FileIdBothDirectoryInformation {
		next_entry_offset: u32,
		file_index:        u32,
		creation_time:     i64,
		last_access_time:  i64,
		last_write_time:   i64,
		change_time:       i64,
		end_of_file:       i64,
		allocation_size:   i64,
		file_attributes:   u32,
		file_name_length:  u32,
		ea_size:           u32,
		short_name_length: i8,
		short_name:        [u16; 12],
		file_id:           i64,
		file_name:         [u16; 1],
	}

	const FILE_OPEN: u32 = 1;
	const FILE_DIRECTORY_FILE: u32 = 0x0000_0001;
	const FILE_NON_DIRECTORY_FILE: u32 = 0x0000_0040;
	const FILE_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
	const FILE_SYNCHRONOUS_IO_NONALERT: u32 = 0x0000_0020;
	const SYNCHRONIZE: u32 = 0x0010_0000;

	struct HeldExact {
		target:    HANDLE,
		// Every component is held until the caller has completed its security-sensitive
		// handle operation. This prevents an ancestor junction replacement from changing
		// the parent used by rename, disposition, or ACL changes.
		ancestors: Vec<HANDLE>,
	}

	impl HeldExact {
		fn parent(&self) -> Option<HANDLE> {
			self.ancestors.last().copied()
		}

		fn retain_child(&mut self, child: HANDLE) {
			let parent = std::mem::replace(&mut self.target, child);
			self.ancestors.push(parent);
		}
	}

	impl Drop for HeldExact {
		fn drop(&mut self) {
			unsafe {
				CloseHandle(self.target);
				for handle in self.ancestors.drain(..).rev() {
					CloseHandle(handle);
				}
			}
		}
	}

	fn close_retained(handles: &mut Vec<HANDLE>) {
		unsafe {
			for handle in handles.drain(..).rev() {
				CloseHandle(handle);
			}
		}
	}

	fn absolute_components(path: &Path) -> Result<(PathBuf, Vec<OsString>), &'static str> {
		if is_network_path(path) {
			return Err("network_unsupported");
		}
		let mut components = path.components();
		let Some(Component::Prefix(prefix)) = components.next() else {
			return Err("identity_unavailable");
		};
		if !matches!(components.next(), Some(Component::RootDir)) {
			return Err("identity_unavailable");
		}
		let mut root = PathBuf::from(prefix.as_os_str());
		root.push("\\");
		let mut names = Vec::new();
		for component in components {
			match component {
				Component::Normal(name) => names.push(name.to_os_string()),
				// Relative, dot, and parent segments would make RootDirectory authority
				// ambiguous; callers must provide an already absolute managed path.
				_ => return Err("identity_unavailable"),
			}
		}
		if names.is_empty() {
			return Err("not_directory");
		}
		Ok((root, names))
	}

	fn ntstatus_code(status: i32) -> &'static str {
		match status as u32 {
			0xc000_0034 | 0xc000_003a => "not_found",
			0xc000_0035 => "quarantine_collision",
			0xc000_0043 => "sharing_violation",
			0xc000_0022 => "owner_mismatch",
			0xc000_00ba => "not_regular_file",
			0xc000_0103 => "not_directory",
			0xc000_050b => "reparse_point",
			0xc000_00d4 => "atomic_unavailable",
			_ => "io_error",
		}
	}

	fn open_relative_with_share(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		desired_access: u32,
		directory: bool,
		share_access: u32,
	) -> Result<HANDLE, &'static str> {
		open_relative_with_share_status(parent, name, desired_access, directory, share_access)
			.map_err(ntstatus_code)
	}

	/// Status-returning variant of [`open_relative_with_share`] used by the
	/// exact-replace destination open so the raw NTSTATUS survives for
	/// transient-sharing-violation classification and path-free diagnostics.
	fn open_relative_with_share_status(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		desired_access: u32,
		directory: bool,
		share_access: u32,
	) -> Result<HANDLE, i32> {
		open_relative_with_disposition_status(
			parent,
			name,
			desired_access,
			directory,
			share_access,
			FILE_OPEN,
		)
	}

	fn open_relative_with_disposition_status(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		desired_access: u32,
		directory: bool,
		share_access: u32,
		create_disposition: u32,
	) -> Result<HANDLE, i32> {
		let mut name: Vec<u16> = name.encode_wide().collect();
		if name.is_empty()
			|| name.iter().any(|unit| *unit == 0)
			|| name.len() > (u16::MAX as usize / 2)
		{
			// This never reaches NtCreateFile, so there is no real NTSTATUS to report;
			// STATUS_INVALID_PARAMETER is the synthetic status for this rejection, and
			// [`ntstatus_code`] maps it back to "io_error" for callers of the
			// string-returning wrapper.
			return Err(STATUS_INVALID_PARAMETER);
		}
		let mut object_name = UnicodeString {
			length:         (name.len() * size_of::<u16>()) as u16,
			maximum_length: (name.len() * size_of::<u16>()) as u16,
			buffer:         name.as_mut_ptr(),
		};
		let mut attributes = ObjectAttributes {
			length: size_of::<ObjectAttributes>() as u32,
			root_directory: parent,
			object_name: &mut object_name,
			// Exact child opens must honor the directory's case semantics. In a
			// case-sensitive directory, `Name` and `name` are distinct authorities.
			attributes: 0,
			security_descriptor: null_mut(),
			security_quality_of_service: null_mut(),
		};
		let mut status: IoStatusBlock = unsafe { std::mem::zeroed() };
		let mut handle = INVALID_HANDLE_VALUE;
		let options = FILE_OPEN_REPARSE_POINT
			| FILE_SYNCHRONOUS_IO_NONALERT
			| if directory {
				FILE_DIRECTORY_FILE
			} else {
				FILE_NON_DIRECTORY_FILE
			};
		let create_status = unsafe {
			NtCreateFile(
				&mut handle,
				desired_access | SYNCHRONIZE,
				&mut attributes,
				&mut status,
				null_mut(),
				FILE_ATTRIBUTE_NORMAL,
				share_access,
				create_disposition,
				options,
				null_mut(),
				0,
			)
		};
		if create_status < 0 {
			return Err(create_status);
		}
		Ok(handle)
	}

	fn open_relative(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		desired_access: u32,
		directory: bool,
	) -> Result<HANDLE, &'static str> {
		open_relative_with_share(
			parent,
			name,
			desired_access,
			directory,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		)
	}

	fn open_exact_with_share(
		path: &Path,
		kind: &str,
		desired_access: u32,
		final_share_access: u32,
	) -> Result<HeldExact, NativeOwnerOnlySecurityResult> {
		if !matches!(kind, "directory" | "file") {
			return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
		}
		let (root, names) =
			absolute_components(path).map_err(NativeOwnerOnlySecurityResult::failure)?;
		// Every directory retained as ObjectAttributes.RootDirectory needs traversal
		// authority for the next descriptor-relative NtCreateFile call.
		let root_handle = open_path(&root, true, FILE_READ_ATTRIBUTES | FILE_TRAVERSE)
			.map_err(NativeOwnerOnlySecurityResult::failure)?;
		let root_attributes = match handle_attributes(root_handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe { CloseHandle(root_handle) };
				return Err(NativeOwnerOnlySecurityResult::failure(code));
			},
		};
		if root_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			unsafe { CloseHandle(root_handle) };
			return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
		}
		let canonical_volume = match final_path(root_handle) {
			Ok(value) => value,
			Err(code) => {
				unsafe { CloseHandle(root_handle) };
				return Err(NativeOwnerOnlySecurityResult::failure(code));
			},
		};
		let mut ancestors = vec![root_handle];
		for (index, name) in names.iter().enumerate() {
			let final_component = index + 1 == names.len();
			let parent = *ancestors.last().expect("volume root retained");
			let handle = match if final_component {
				open_relative_with_share(
					parent,
					name,
					desired_access | FILE_READ_ATTRIBUTES,
					kind == "directory",
					final_share_access,
				)
			} else {
				// This retained directory becomes RootDirectory for the next
				// descriptor-relative NtCreateFile, which requires traversal
				// authority as well as attribute inspection.
				open_relative(parent, name, FILE_READ_ATTRIBUTES | FILE_TRAVERSE, true)
			} {
				Ok(handle) => handle,
				Err(code) => {
					close_retained(&mut ancestors);
					return Err(NativeOwnerOnlySecurityResult::failure(code));
				},
			};
			let attributes = match handle_attributes(handle) {
				Ok(attributes) => attributes,
				Err(code) => {
					unsafe { CloseHandle(handle) };
					close_retained(&mut ancestors);
					return Err(NativeOwnerOnlySecurityResult::failure(code));
				},
			};
			if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				unsafe { CloseHandle(handle) };
				close_retained(&mut ancestors);
				return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
			}
			if final_component {
				let canonical_target = match final_path(handle) {
					Ok(value) => value,
					Err(code) => {
						unsafe { CloseHandle(handle) };
						close_retained(&mut ancestors);
						return Err(NativeOwnerOnlySecurityResult::failure(code));
					},
				};
				if !canonical_target.starts_with(&canonical_volume) {
					unsafe { CloseHandle(handle) };
					close_retained(&mut ancestors);
					return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
				}
				return Ok(HeldExact { target: handle, ancestors });
			}
			ancestors.push(handle);
		}
		unreachable!("absolute_components rejects a volume root target")
	}

	fn open_exact(
		path: &Path,
		kind: &str,
		desired_access: u32,
	) -> Result<HeldExact, NativeOwnerOnlySecurityResult> {
		open_exact_with_share(
			path,
			kind,
			desired_access,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		)
	}

	fn open_directory_exact(path: &Path) -> Result<HeldExact, String> {
		match open_exact(path, "directory", FILE_READ_ATTRIBUTES | FILE_TRAVERSE) {
			Ok(handle) => Ok(handle),
			Err(_result)
				if path
					.components()
					.all(|component| matches!(component, Component::Prefix(_) | Component::RootDir)) =>
			{
				let handle = open_path(path, true, FILE_READ_ATTRIBUTES | FILE_TRAVERSE)
					.map_err(str::to_owned)?;
				let attributes = match handle_attributes(handle) {
					Ok(attributes) => attributes,
					Err(code) => {
						unsafe { CloseHandle(handle) };
						return Err(code.to_owned());
					},
				};
				if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
					unsafe { CloseHandle(handle) };
					return Err("reparse_point".to_owned());
				}
				Ok(HeldExact { target: handle, ancestors: Vec::new() })
			},
			Err(result) => Err(result.code.unwrap_or_else(|| "io_error".to_owned())),
		}
	}

	fn handle_identity_matches(
		information: &BY_HANDLE_FILE_INFORMATION,
		identity: &ExactFileIdentity,
	) -> bool {
		let ino =
			(u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
		let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
		let filetime = (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
			| u64::from(information.ftLastWriteTime.dwLowDateTime);
		let mtime_ns = i128::from(filetime) * 100 - 11_644_473_600_000_000_000i128;
		u64::from(information.dwVolumeSerialNumber) == identity.dev
			&& ino == identity.ino
			&& size == identity.size
			&& mtime_ns == i128::from(identity.mtime_ns)
	}

	fn handles_same_object_checked(left: HANDLE, right: HANDLE) -> Result<bool, &'static str> {
		let mut left_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		let mut right_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(left, &mut left_information) } == 0
			|| unsafe { GetFileInformationByHandle(right, &mut right_information) } == 0
		{
			return Err(last_error_code());
		}
		Ok(left_information.dwVolumeSerialNumber == right_information.dwVolumeSerialNumber
			&& left_information.nFileIndexHigh == right_information.nFileIndexHigh
			&& left_information.nFileIndexLow == right_information.nFileIndexLow)
	}

	fn handles_same_object(left: HANDLE, right: HANDLE) -> bool {
		handles_same_object_checked(left, right).unwrap_or(false)
	}

	fn rename_handle(
		handle: HANDLE,
		parent_handle: HANDLE,
		name: &[u16],
		replace_if_exists: bool,
	) -> Result<(), &'static str> {
		let name_bytes = name.len().checked_mul(size_of::<u16>()).ok_or("io_error")?;
		let file_name_offset = std::mem::offset_of!(HandleRenameInformation, file_name);
		let allocation_size = file_name_offset
			.checked_add(name_bytes)
			.ok_or("io_error")?
			.max(size_of::<HandleRenameInformation>());
		let allocation_size_u32 = u32::try_from(allocation_size).map_err(|_| "io_error")?;
		if file_name_offset % align_of::<u16>() != 0 {
			return Err("io_error");
		}
		let words = allocation_size
			.checked_add(size_of::<usize>() - 1)
			.ok_or("io_error")?
			/ size_of::<usize>();
		let mut storage = vec![0usize; words];
		let rename = storage.as_mut_ptr().cast::<HandleRenameInformation>();
		// SAFETY: `storage` is usize-aligned and spans the complete fixed ABI
		// structure plus the checked trailing UTF-16 name. The name pointer is
		// computed from the field offset rather than from the one-element flexible
		// array member, so the copy never creates an out-of-bounds array reference.
		unsafe {
			(*rename).replace_if_exists = u8::from(replace_if_exists);
			(*rename).root_directory = parent_handle;
			(*rename).file_name_length = u32::try_from(name_bytes).map_err(|_| "io_error")?;
			let file_name = storage
				.as_mut_ptr()
				.cast::<u8>()
				.add(file_name_offset)
				.cast::<u16>();
			std::ptr::copy_nonoverlapping(name.as_ptr(), file_name, name.len());
		}
		// SAFETY: `handle` and `parent_handle` are retained handles, and `storage`
		// supplies the aligned FILE_RENAME_INFORMATION layout through the real
		// `file_name` field offset plus exactly the checked trailing UTF-16 byte
		// length. NtSetInformationFile accepts the retained parent handle as relative
		// rename authority, unlike the Win32 wrapper on all supported filesystems.
		let mut status: IoStatusBlock = unsafe { std::mem::zeroed() };
		let rename_status = unsafe {
			NtSetInformationFile(
				handle,
				&raw mut status,
				storage.as_mut_ptr().cast(),
				allocation_size_u32,
				FILE_RENAME_INFORMATION_CLASS,
			)
		};
		if rename_status >= 0 {
			Ok(())
		} else {
			Err(ntstatus_code(rename_status))
		}
	}

	fn detach_directory(
		handle: HANDLE,
		parent_handle: HANDLE,
		source_name: &std::ffi::OsStr,
		quarantine_name: &str,
		detached_path: String,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let name_wide: Vec<u16> = quarantine_name.encode_utf16().collect();
		let original_name_wide: Vec<u16> = source_name.encode_wide().collect();
		let result = match rename_handle(handle, parent_handle, &name_wide, false) {
			Ok(()) => {
				let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
				let matches = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0
					&& handle_identity_matches(&information, identity)
					&& (identity.directory
						|| (information.nNumberOfLinks == 1
							&& digest_handle(handle).ok().as_ref() == identity.sha256.as_ref()));
				if matches {
					NativeExactUnlinkResult::detached(detached_path)
				} else if rename_handle(handle, parent_handle, &original_name_wide, false).is_ok() {
					NativeExactUnlinkResult::failure("identity_mismatch")
				} else {
					NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
				}
			},
			Err("quarantine_collision") => NativeExactUnlinkResult::failure("quarantine_collision"),
			Err(code) => NativeExactUnlinkResult::failure(code),
		};
		result
	}

	fn digest_handle(handle: HANDLE) -> Result<[u8; 32], &'static str> {
		if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
			return Err(last_error_code());
		}
		let mut hasher = Sha256::new();
		let mut chunk = [0u8; 64 * 1024];
		loop {
			let mut read = 0u32;
			if unsafe {
				ReadFile(handle, chunk.as_mut_ptr().cast(), chunk.len() as u32, &mut read, null_mut())
			} == 0
			{
				return Err(last_error_code());
			}
			hasher.update(&chunk[..read as usize]);
			if read < chunk.len() as u32 {
				return Ok(hasher.finalize().into());
			}
		}
	}

	fn lexical_absolute_path(path: &Path) -> Result<PathBuf, &'static str> {
		let path = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_err(|_| "io_error")?.join(path)
		};
		let mut normalized = PathBuf::new();
		for component in path.components() {
			match component {
				Component::Prefix(prefix) => normalized.push(prefix.as_os_str()),
				Component::RootDir => normalized.push("\\"),
				Component::CurDir => {},
				Component::ParentDir => {
					if !normalized.pop() {
						return Err("io_error");
					}
				},
				Component::Normal(name) => normalized.push(name),
			}
		}
		if normalized.is_absolute() {
			Ok(normalized)
		} else {
			Err("io_error")
		}
	}
	pub(super) fn exact_replace_path(
		source_path: &Path,
		destination_path: &Path,
		expected_source: &ExactFileIdentity,
		expected_destination: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if expected_source.directory
			|| expected_source.detach_only
			|| expected_destination.directory
			|| expected_destination.detach_only
		{
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		if expected_source.parent_dev.is_none()
			|| expected_source.parent_ino.is_none()
			|| expected_destination.parent_dev.is_none()
			|| expected_destination.parent_ino.is_none()
		{
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let source_path = match lexical_absolute_path(source_path) {
			Ok(path) => path,
			Err(code) => return NativeExactUnlinkResult::failure(code),
		};
		let destination_path = match lexical_absolute_path(destination_path) {
			Ok(path) => path,
			Err(code) => return NativeExactUnlinkResult::failure(code),
		};
		if source_path.parent() != destination_path.parent() {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let source = match open_exact_with_share(
			&source_path,
			"file",
			FILE_READ_ATTRIBUTES | FILE_READ_DATA | 0x0001_0000,
			FILE_SHARE_READ,
		) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult::failure(result.code.as_deref().unwrap_or("io_error"));
			},
		};
		let mut source_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(source.target, &mut source_information) } == 0
			|| source_information.dwFileAttributes
				& (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
				!= 0 || !handle_identity_matches(&source_information, expected_source)
			|| digest_handle(source.target).ok().as_ref() != expected_source.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if source_information.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		let Some(parent_handle) = source.parent() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		if let Some((expected_parent_dev, expected_parent_ino)) =
			expected_source.parent_dev.zip(expected_source.parent_ino)
		{
			let mut parent_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(parent_handle, &mut parent_information) } == 0
				|| u64::from(parent_information.dwVolumeSerialNumber) != expected_parent_dev
				|| ((u64::from(parent_information.nFileIndexHigh) << 32)
					| u64::from(parent_information.nFileIndexLow))
					!= expected_parent_ino
			{
				return NativeExactUnlinkResult::failure("parent_mismatch");
			}
		}
		if expected_source.parent_dev != expected_destination.parent_dev
			|| expected_source.parent_ino != expected_destination.parent_ino
		{
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let Some(destination_name) = destination_path.file_name() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		// The destination is opened relative to the source's retained no-follow parent;
		// no destination pathname is reopened after this point. This open is the only
		// pre-mutation syscall that can transiently fail with STATUS_SHARING_VIOLATION
		// (a concurrent holder denying delete sharing, issue #4330): it happens before
		// any rename or unlink, so the bounded retry below can never publish twice. The
		// same open in a later phase would be post-mutation evidence and is
		// deliberately NOT retried — a failure there is surfaced with its retained
		// paths instead.
		let destination_handle = match open_with_transient_retry(|| {
			if take_injected_exact_replace_destination_open_sharing_violation() {
				return Err(STATUS_SHARING_VIOLATION);
			}
			open_relative_with_share_status(
				parent_handle,
				destination_name,
				FILE_READ_ATTRIBUTES | 0x0001_0000 | FILE_WRITE_ATTRIBUTES | FILE_READ_DATA,
				false,
				FILE_SHARE_READ | FILE_SHARE_DELETE,
			)
		}) {
			Ok(handle) => handle,
			Err(status) => {
				return NativeExactUnlinkResult::failure(
					if is_retryable_exact_replace_status(status) {
						// Retry budget exhausted: the holder never released. Surface the
						// specific category instead of a bare io_error so the session crash
						// log and operator diagnostics can identify a sharing conflict.
						"sharing_violation"
					} else {
						ntstatus_code(status)
					},
				)
				.with_windows_error_code(native_windows_error_code(status));
			},
		};
		let destination = HeldExact { target: destination_handle, ancestors: Vec::new() };

		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(destination.target, &mut information) } == 0 {
			return NativeExactUnlinkResult::failure(last_error_code());
		}
		if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return NativeExactUnlinkResult::failure("reparse_point");
		}
		if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
			|| !handle_identity_matches(&information, expected_destination)
			|| digest_handle(destination.target).ok().as_ref() != expected_destination.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if information.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		let mut revalidated: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(destination.target, &mut revalidated) } == 0
			|| !handle_identity_matches(&revalidated, expected_destination)
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if revalidated.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		match handles_same_object_checked(source.target, destination.target) {
			Ok(true) => return NativeExactUnlinkResult::failure("identity_mismatch"),
			Ok(false) => {},
			Err(code) => return NativeExactUnlinkResult::failure(code),
		}
		let mut source_revalidated: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(source.target, &mut source_revalidated) } == 0
			|| !handle_identity_matches(&source_revalidated, expected_source)
			|| digest_handle(source.target).ok().as_ref() != expected_source.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if source_revalidated.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		let retained_name_string =
			format!(".gjc-exact-replace-source-{:x}-{:x}", expected_source.dev, expected_source.ino);
		let retained_path = source_path.with_file_name(&retained_name_string);
		let retained_name: Vec<u16> = retained_name_string.encode_utf16().collect();
		if let Err(code) = rename_handle(source.target, parent_handle, &retained_name, false) {
			return NativeExactUnlinkResult::failure(code);
		}
		let retained_path_string = retained_path.to_string_lossy().into_owned();
		let mut retained_source: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(source.target, &mut retained_source) } == 0
			|| !handle_identity_matches(&retained_source, expected_source)
			|| digest_handle(source.target).ok().as_ref() != expected_source.sha256.as_ref()
		{
			return NativeExactUnlinkResult::detached_failure(
				"identity_mismatch",
				retained_path_string,
			);
		}
		if retained_source.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::detached_failure(
				"hard_link_unsupported",
				retained_path_string,
			);
		}
		let mut destination_revalidated: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(destination.target, &mut destination_revalidated) }
			== 0 || !handle_identity_matches(&destination_revalidated, expected_destination)
			|| digest_handle(destination.target).ok().as_ref() != expected_destination.sha256.as_ref()
		{
			return NativeExactUnlinkResult::detached_failure(
				"identity_mismatch",
				retained_path_string,
			);
		}
		if destination_revalidated.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::detached_failure(
				"hard_link_unsupported",
				retained_path_string,
			);
		}
		let destination_name: Vec<u16> = destination_name.encode_wide().collect();
		let predecessor_name_string = format!(
			".gjc-exact-replace-destination-{:x}-{:x}",
			expected_destination.dev, expected_destination.ino
		);
		let predecessor_path = destination_path.with_file_name(&predecessor_name_string);
		let predecessor_name: Vec<u16> = predecessor_name_string.encode_utf16().collect();
		if let Err(code) = rename_handle(destination.target, parent_handle, &predecessor_name, false)
		{
			return NativeExactUnlinkResult::detached_failure(code, retained_path_string);
		}
		let predecessor_path_string = predecessor_path.to_string_lossy().into_owned();
		match rename_handle(source.target, parent_handle, &destination_name, false) {
			Ok(()) => match delete_handle(destination.target) {
				Ok(()) => NativeExactUnlinkResult::success(),
				Err(code) => NativeExactUnlinkResult::detached_failure_with_successor_and_placeholder(
					code,
					predecessor_path_string.clone(),
					destination_path.to_string_lossy().into_owned(),
					predecessor_path_string,
				),
			},
			Err(code) => {
				let restored_destination =
					rename_handle(destination.target, parent_handle, &destination_name, false).is_ok();
				if restored_destination {
					NativeExactUnlinkResult::detached_failure(code, retained_path_string)
				} else {
					NativeExactUnlinkResult::detached_failure_with_successor_and_placeholder(
						code,
						retained_path_string,
						destination_path.to_string_lossy().into_owned(),
						predecessor_path_string,
					)
				}
			},
		}
	}

	/// Windows implements no-replace renames natively, so the POSIX hard-link
	/// stand-in is never requested here and is reported as unavailable rather
	/// than emulated.
	pub(super) fn link_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}

	pub(super) fn rename_directory_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}

	pub(super) fn rename_path_no_replace(
		source_path: &Path,
		destination_path: &Path,
	) -> NativeExactUnlinkResult {
		let source_path = match lexical_absolute_path(source_path) {
			Ok(path) => path,
			Err(code) => return NativeExactUnlinkResult::failure(code),
		};
		let destination_path = match lexical_absolute_path(destination_path) {
			Ok(path) => path,
			Err(code) => return NativeExactUnlinkResult::failure(code),
		};
		let source_kind = match std::fs::symlink_metadata(&source_path) {
			Ok(metadata) if metadata.file_type().is_dir() => "directory",
			Ok(_) => "file",
			Err(error)
				if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32)
					|| error.raw_os_error() == Some(ERROR_PATH_NOT_FOUND as i32) =>
			{
				return NativeExactUnlinkResult::failure("not_found");
			},
			Err(_) => return NativeExactUnlinkResult::failure("io_error"),
		};
		let source = match open_exact(&source_path, source_kind, FILE_READ_ATTRIBUTES | 0x0001_0000) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult::failure(result.code.as_deref().unwrap_or("io_error"));
			},
		};
		let Some(destination_parent_path) = destination_path.parent() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Some(destination_name) = destination_path.file_name() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let destination_parent = match open_directory_exact(destination_parent_path) {
			Ok(handle) => handle,
			Err(code) => return NativeExactUnlinkResult::failure(&code),
		};
		let destination_name: Vec<u16> = destination_name.encode_wide().collect();
		match rename_handle(source.target, destination_parent.target, &destination_name, false) {
			Ok(()) => NativeExactUnlinkResult::success(),
			Err(code) => NativeExactUnlinkResult::failure(code),
		}
	}
	pub(super) fn exact_unlink(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let kind = if identity.directory {
			"directory"
		} else {
			"file"
		};
		// DELETE is deliberately requested on the opened final handle: disposition or
		// rename then applies to that object, not to a later pathname replacement.
		let desired_access = FILE_READ_ATTRIBUTES
			| 0x0001_0000
			| if !identity.directory && !identity.detach_only {
				FILE_WRITE_ATTRIBUTES
			} else {
				0
			} | if identity.directory {
			0
		} else {
			FILE_READ_DATA
		};
		let handle = match if identity.directory {
			open_exact(path, kind, desired_access)
		} else {
			open_exact_with_share(path, kind, desired_access, FILE_SHARE_READ)
		} {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok: false,
					code: result.code,
					payload_durable: None,
					detached_path: None,
					retained_successor_path: None,
					retained_placeholder_path: None,
					retained_unknown_path: None,
					windows_error_code: None,
				};
			},
		};
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut information) } == 0 {
			return NativeExactUnlinkResult::failure(last_error_code());
		}
		if !handle_identity_matches(&information, identity) {
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory && !identity.allow_hard_link && information.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		if !identity.directory
			&& digest_handle(handle.target).ok().as_ref() != identity.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory && !identity.detach_only {
			if let Some((expected_parent_dev, expected_parent_ino)) =
				identity.parent_dev.zip(identity.parent_ino)
			{
				let Some(parent_handle) = handle.parent() else {
					return NativeExactUnlinkResult::failure("io_error");
				};
				let mut parent_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
				if unsafe { GetFileInformationByHandle(parent_handle, &mut parent_information) } == 0
					|| u64::from(parent_information.dwVolumeSerialNumber) != expected_parent_dev
					|| ((u64::from(parent_information.nFileIndexHigh) << 32)
						| u64::from(parent_information.nFileIndexLow))
						!= expected_parent_ino
				{
					return NativeExactUnlinkResult::failure("parent_mismatch");
				}
			}
		}
		if identity.directory || identity.detach_only {
			let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
				return NativeExactUnlinkResult::failure("quarantine_destination_required");
			};
			let Some(parent_handle) = handle.parent() else {
				return NativeExactUnlinkResult::failure("io_error");
			};
			if let Some((expected_parent_dev, expected_parent_ino)) =
				identity.parent_dev.zip(identity.parent_ino)
			{
				let mut parent_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
				if unsafe { GetFileInformationByHandle(parent_handle, &mut parent_information) } == 0
					|| u64::from(parent_information.dwVolumeSerialNumber) != expected_parent_dev
					|| ((u64::from(parent_information.nFileIndexHigh) << 32)
						| u64::from(parent_information.nFileIndexLow))
						!= expected_parent_ino
				{
					return NativeExactUnlinkResult::failure("parent_mismatch");
				}
			}
			let Some(original_name) = path.file_name() else {
				return NativeExactUnlinkResult::failure("io_error");
			};
			let Some(parent_path) = path.parent() else {
				return NativeExactUnlinkResult::failure("io_error");
			};
			let detached_path = parent_path
				.join(quarantine_name)
				.to_string_lossy()
				.into_owned();
			return detach_directory(
				handle.target,
				parent_handle,
				original_name,
				quarantine_name,
				detached_path,
				identity,
			);
		}
		match delete_handle(handle.target) {
			Ok(()) => NativeExactUnlinkResult::success(),
			Err(code) => NativeExactUnlinkResult::failure(code),
		}
	}

	/// Regular-file exact unlink on Windows already operates on the validated
	/// handle, so the direct debris path can reuse it without creating a
	/// quarantine or exchange placeholder.
	pub(super) fn exact_unlink_direct(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		if identity.directory || identity.detach_only {
			return NativeExactUnlinkResult::failure("invalid_request");
		}
		exact_unlink(path, identity)
	}

	pub(super) fn exact_restore(
		detached_path: &Path,
		original_path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let kind = if identity.directory {
			"directory"
		} else {
			"file"
		};
		let desired_access = FILE_READ_ATTRIBUTES
			| 0x0001_0000
			| if identity.directory {
				0
			} else {
				FILE_READ_DATA
			};
		let handle = match if identity.directory {
			open_exact(detached_path, kind, desired_access)
		} else {
			open_exact_with_share(detached_path, kind, desired_access, FILE_SHARE_READ)
		} {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok: false,
					code: result.code,
					payload_durable: None,
					detached_path: None,
					retained_successor_path: None,
					retained_placeholder_path: None,
					retained_unknown_path: None,
					windows_error_code: None,
				};
			},
		};
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut information) } == 0 {
			return NativeExactUnlinkResult::failure(last_error_code());
		}
		if !handle_identity_matches(&information, identity)
			|| (!identity.directory
				&& digest_handle(handle.target).ok().as_ref() != identity.sha256.as_ref())
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory && information.nNumberOfLinks != 1 {
			return NativeExactUnlinkResult::failure("hard_link_unsupported");
		}
		if identity.parent_dev.is_none() || identity.parent_ino.is_none() {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		let Some(source_name) = detached_path.file_name() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Some(quarantine_name) = original_path.file_name().and_then(|name| name.to_str()) else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Some(detached_parent_handle) = handle.parent() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let Some(original_parent_path) = original_path.parent() else {
			return NativeExactUnlinkResult::failure("io_error");
		};
		let original_parent = match open_directory_exact(original_parent_path) {
			Ok(parent) => parent,
			Err(code) => return NativeExactUnlinkResult::failure(&code),
		};
		if !handles_same_object(detached_parent_handle, original_parent.target) {
			return NativeExactUnlinkResult::failure("parent_mismatch");
		}
		if let Some((expected_parent_dev, expected_parent_ino)) =
			identity.parent_dev.zip(identity.parent_ino)
		{
			let mut parent_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(original_parent.target, &mut parent_information) }
				== 0 || u64::from(parent_information.dwVolumeSerialNumber) != expected_parent_dev
				|| ((u64::from(parent_information.nFileIndexHigh) << 32)
					| u64::from(parent_information.nFileIndexLow))
					!= expected_parent_ino
			{
				return NativeExactUnlinkResult::failure("parent_mismatch");
			}
		}
		let result = detach_directory(
			handle.target,
			original_parent.target,
			source_name,
			quarantine_name,
			original_path.to_string_lossy().into_owned(),
			identity,
		);
		match result {
			NativeExactUnlinkResult { ok: true, .. } => NativeExactUnlinkResult::success(),
			NativeExactUnlinkResult { code: Some(code), .. } if code == "quarantine_collision" => {
				NativeExactUnlinkResult::failure("collision")
			},
			result => result,
		}
	}

	fn valid_sid(sid: &[u8]) -> Option<usize> {
		const SID_HEADER_SIZE: usize = 8;
		let sub_authorities = usize::from(*sid.get(1)?);
		let length = SID_HEADER_SIZE.checked_add(sub_authorities.checked_mul(size_of::<u32>())?)?;
		if length > sid.len() || (sid.as_ptr() as usize) % align_of::<u32>() != 0 {
			return None;
		}
		// SAFETY: the checked SID header and sub-authority count keep the complete SID
		// inside `sid`, which is u32-aligned storage, so the Windows validator may
		// inspect it.
		(unsafe { IsValidSid(sid.as_ptr().cast_mut().cast()) } != 0).then_some(length)
	}

	fn current_user_sid() -> Result<Vec<u8>, ()> {
		let mut token: HANDLE = null_mut();
		// SAFETY: the current-process pseudo-handle is valid and `token` is writable
		// for the API.
		if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
			return Err(());
		}
		let mut size = 0u32;
		// SAFETY: this size probe has a valid token and writable size pointer; its null
		// buffer is required by the documented probe form.
		unsafe { GetTokenInformation(token, 1, null_mut(), 0, &mut size) };
		let bytes = usize::try_from(size).map_err(|_| ())?;
		if bytes < size_of::<TOKEN_USER>() {
			// SAFETY: `token` was returned by OpenProcessToken and is closed exactly once
			// here.
			unsafe { CloseHandle(token) };
			return Err(());
		}
		let words = bytes.checked_add(size_of::<usize>() - 1).ok_or(())? / size_of::<usize>();
		let mut token_user = vec![0usize; words];
		let capacity =
			u32::try_from(words.checked_mul(size_of::<usize>()).ok_or(())?).map_err(|_| ())?;
		// SAFETY: the aligned allocation has at least the probed byte capacity and the
		// token and out-size pointer remain valid for the synchronous call.
		let ok = unsafe {
			GetTokenInformation(token, 1, token_user.as_mut_ptr().cast(), capacity, &mut size)
		} != 0;
		// SAFETY: `token` was returned by OpenProcessToken and is closed exactly once
		// here.
		unsafe { CloseHandle(token) };
		if !ok || usize::try_from(size).map_err(|_| ())? < size_of::<TOKEN_USER>() || size > capacity
		{
			return Err(());
		}
		// SAFETY: the successful API wrote at least TOKEN_USER bytes into usize-aligned
		// storage.
		let user = unsafe { &*token_user.as_ptr().cast::<TOKEN_USER>() };
		let base = token_user.as_ptr().cast::<u8>() as usize;
		let returned_bytes = usize::try_from(size).map_err(|_| ())?;
		let end = base.checked_add(returned_bytes).ok_or(())?;
		let sid_ptr = user.User.Sid.cast::<u8>();
		let sid_start = sid_ptr as usize;
		if sid_start < base || sid_start.checked_add(8).ok_or(())? > end {
			return Err(());
		}
		let available = end.checked_sub(sid_start).ok_or(())?;
		// SAFETY: the pointer range is bounded by the exact byte count returned by the
		// successful token-information query, not by rounded allocation capacity.
		let sid_bytes = unsafe { std::slice::from_raw_parts(sid_ptr, available) };
		let sid_length = valid_sid(sid_bytes).ok_or(())?;
		// SAFETY: valid_sid proved the returned SID's exact length lies in `sid_bytes`.
		let reported_length =
			usize::try_from(unsafe { GetLengthSid(user.User.Sid) }).map_err(|_| ())?;
		if reported_length != sid_length {
			return Err(());
		}
		Ok(sid_bytes[..sid_length].to_vec())
	}

	const OBJECT_INHERIT_ACE: u8 = 0x01;
	const CONTAINER_INHERIT_ACE: u8 = 0x02;
	const SE_DACL_PROTECTED: u16 = 0x1000;

	fn owner_only_ace_mask_is_safe(mask: u32) -> bool {
		matches!(mask, GENERIC_ALL | FILE_ALL_ACCESS)
	}

	fn owner_only_dacl(sid: &[u8], kind: &str) -> Result<Vec<usize>, ()> {
		let sid_length = valid_sid(sid).ok_or(())?;
		let size = size_of::<ACL>()
			.checked_add(size_of::<ACCESS_ALLOWED_ACE>())
			.and_then(|size| size.checked_add(sid_length))
			.ok_or(())?;
		let size_u32 = u32::try_from(size).map_err(|_| ())?;
		let words = size.checked_add(size_of::<usize>() - 1).ok_or(())? / size_of::<usize>();
		let mut buffer = vec![0usize; words];
		let acl = buffer.as_mut_ptr().cast::<ACL>();
		let ace_flags = if kind == "directory" {
			OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
		} else {
			0
		};
		// SAFETY: `buffer` is ACL-aligned, has the checked u32 byte capacity, and `sid`
		// was validated as a complete aligned SID that remains live for both
		// synchronous API calls.
		if unsafe { InitializeAcl(acl, size_u32, ACL_REVISION) } == 0
			// SAFETY: InitializeAcl initialized the aligned ACL allocation and its checked size
			// leaves room for the requested ACE and validated SID.
			|| unsafe {
				AddAccessAllowedAceEx(
					acl,
					ACL_REVISION,
					u32::from(ace_flags),
					FILE_ALL_ACCESS,
					sid.as_ptr().cast_mut().cast(),
				)
			} == 0
		{
			return Err(());
		}
		Ok(buffer)
	}

	#[derive(Clone, Copy)]
	enum OwnerOnlyAclState {
		Clean,
		RepairableMismatch,
		UnsafeMismatch,
		OwnerMismatch,
	}

	fn acl_entries_are_structurally_valid(
		dacl: *mut ACL,
		ace_count: u32,
		acl_start: usize,
		acl_end: usize,
	) -> bool {
		for index in 0..ace_count {
			let mut ace: *mut c_void = null_mut();
			// SAFETY: `dacl` and `ace` remain inside the live descriptor returned by
			// GetSecurityInfo, and `ace` is a writable output pointer.
			if unsafe { GetAce(dacl, index, &mut ace) } == 0 || ace.is_null() {
				return false;
			}
			let ace_start = ace as usize;
			let Some(header_end) = ace_start.checked_add(size_of::<ACE_HEADER>()) else {
				return false;
			};
			if ace_start < acl_start || header_end > acl_end {
				return false;
			}
			// SAFETY: the fixed ACE header range is bounded by the ACL extent; the
			// unaligned read avoids imposing an alignment assumption on GetAce.
			let header = unsafe { std::ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
			let ace_size = usize::from(header.AceSize);
			let Some(ace_end) = ace_start.checked_add(ace_size) else {
				return false;
			};
			if ace_size < size_of::<ACE_HEADER>() || ace_end > acl_end {
				return false;
			}
			if header.AceType == 0 {
				let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
				let Some(sid_end) = sid_offset.checked_add(8) else {
					return false;
				};
				if sid_end > ace_size {
					return false;
				}
				// SAFETY: `sid_offset..ace_size` lies within the checked ACE and ACL
				// extents, and the descriptor remains live through validation.
				let ace_sid = unsafe {
					std::slice::from_raw_parts(ace.cast::<u8>().add(sid_offset), ace_size - sid_offset)
				};
				if valid_sid(ace_sid).is_none() {
					return false;
				}
			}
		}
		true
	}

	fn inspect_owner_only_acl(
		handle: HANDLE,
		kind: &str,
		sid: &[u8],
	) -> Result<OwnerOnlyAclState, &'static str> {
		let mut owner = null_mut();
		let mut dacl = null_mut();
		let mut descriptor = null_mut();
		// SAFETY: the retained handle is valid and all output pointers are writable
		// until the returned LocalAlloc descriptor is released below.
		let status = unsafe {
			GetSecurityInfo(
				handle,
				SE_FILE_OBJECT,
				SECURITY_OWNER_DACL,
				&mut owner,
				null_mut(),
				&mut dacl,
				null_mut(),
				&mut descriptor,
			)
		};
		if status != 0 {
			if !descriptor.is_null() {
				// SAFETY: a non-null descriptor returned by GetSecurityInfo remains owned by
				// this function on the error path.
				unsafe { LocalFree(descriptor) };
			}
			return Err("acl_unavailable");
		}
		if descriptor.is_null() {
			return Err("acl_unavailable");
		}
		let result = if owner.is_null() {
			Err("acl_unavailable")
		} else {
			// SAFETY: GetSecurityInfo returned owner within the live security
			// descriptor; `sid` is a validated current-user SID.
			let owner_matches = unsafe { EqualSid(owner, sid.as_ptr().cast_mut().cast()) } != 0;
			if !owner_matches {
				Ok(OwnerOnlyAclState::OwnerMismatch)
			} else {
				let mut control = 0u16;
				let mut revision = 0u32;
				// SAFETY: `descriptor` is the live allocation returned by GetSecurityInfo
				// and both outputs are writable local scalars.
				let control_ok = unsafe {
					windows_sys::Win32::Security::GetSecurityDescriptorControl(
						descriptor,
						&mut control,
						&mut revision,
					)
				} != 0;
				if !control_ok {
					Ok(OwnerOnlyAclState::UnsafeMismatch)
				} else {
					let protected_dacl = control & SE_DACL_PROTECTED != 0;
					// SAFETY: zero is a valid output initialization for ACL_SIZE_INFORMATION.
					let mut acl_info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
					let acl_ok = !dacl.is_null()
						// SAFETY: GetSecurityInfo returned `dacl` within its still-live
						// descriptor and `acl_info` is an aligned writable output.
						&& unsafe {
							GetAclInformation(
								dacl,
								(&raw mut acl_info).cast(),
								u32::try_from(size_of::<ACL_SIZE_INFORMATION>())
									.expect("ACL info size fits u32"),
								AclSizeInformation,
							)
						} != 0;
					if !acl_ok {
						Ok(OwnerOnlyAclState::UnsafeMismatch)
					} else {
						let acl_start = dacl as usize;
						let acl_bytes = acl_info.AclBytesInUse as usize;
						let acl_end = acl_start.checked_add(acl_bytes);
						let structurally_valid = acl_bytes >= size_of::<ACL>()
							&& acl_end.is_some_and(|end| {
								acl_entries_are_structurally_valid(dacl, acl_info.AceCount, acl_start, end)
							});
						if !structurally_valid {
							Ok(OwnerOnlyAclState::UnsafeMismatch)
						} else {
							let expected_flags = if kind == "directory" {
								OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
							} else {
								0
							};
							let exact_owner_ace = if acl_info.AceCount == 1 {
								let mut ace: *mut c_void = null_mut();
								// SAFETY: structural validation above proved that this single ACE
								// is present and bounded; `ace` is a writable output pointer.
								if unsafe { GetAce(dacl, 0, &mut ace) } == 0 || ace.is_null() {
									false
								} else {
									let header =
										unsafe { std::ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
									let ace_size = usize::from(header.AceSize);
									let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
									let mask_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, Mask);
									if header.AceType != 0
										|| header.AceFlags != expected_flags
										|| mask_offset
											.checked_add(size_of::<u32>())
											.is_none_or(|end| end > ace_size)
										|| sid_offset > ace_size
									{
										false
									} else {
										// SAFETY: structural validation proved the mask and SID ranges
										// are inside the live ACE.
										let mask = unsafe {
											std::ptr::read_unaligned(
												ace.cast::<u8>().add(mask_offset).cast::<u32>(),
											)
										};
										let ace_sid = unsafe {
											std::slice::from_raw_parts(
												ace.cast::<u8>().add(sid_offset),
												ace_size - sid_offset,
											)
										};
										owner_only_ace_mask_is_safe(mask)
											&& valid_sid(ace_sid).is_some()
											// SAFETY: both pointers identify complete validated SIDs
											// that remain live through comparison.
											&& unsafe {
												EqualSid(
													ace_sid.as_ptr().cast_mut().cast(),
													sid.as_ptr().cast_mut().cast(),
												)
											} != 0
									}
								}
							} else {
								false
							};
							if protected_dacl && exact_owner_ace {
								Ok(OwnerOnlyAclState::Clean)
							} else {
								Ok(OwnerOnlyAclState::RepairableMismatch)
							}
						}
					}
				}
			}
		};
		// SAFETY: GetSecurityInfo allocated `descriptor` with LocalAlloc and it is
		// released once after all owner, ACL, and ACE reads have completed.
		unsafe { LocalFree(descriptor) };
		result
	}

	fn verify_owner_only_handle(handle: HANDLE, kind: &str) -> NativeOwnerOnlySecurityResult {
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		match inspect_owner_only_acl(handle, kind, &sid) {
			Ok(OwnerOnlyAclState::Clean) => NativeOwnerOnlySecurityResult::success(),
			Ok(OwnerOnlyAclState::OwnerMismatch) => {
				NativeOwnerOnlySecurityResult::failure("owner_mismatch")
			},
			Ok(OwnerOnlyAclState::RepairableMismatch | OwnerOnlyAclState::UnsafeMismatch) => {
				NativeOwnerOnlySecurityResult::failure("acl_verify_failed")
			},
			Err(code) => NativeOwnerOnlySecurityResult::failure(code),
		}
	}

	fn set_owner_only_acl(
		handle: HANDLE,
		kind: &str,
		sid: &[u8],
		repair_owner: bool,
	) -> NativeOwnerOnlySecurityResult {
		let dacl = match owner_only_dacl(sid, kind) {
			Ok(dacl) => dacl,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_apply_failed"),
		};
		let status = unsafe {
			SetSecurityInfo(
				handle,
				SE_FILE_OBJECT,
				if repair_owner {
					SECURITY_OWNER_DACL_PROTECTED
				} else {
					SECURITY_DACL_PROTECTED
				},
				if repair_owner {
					sid.as_ptr().cast_mut().cast()
				} else {
					null_mut()
				},
				null_mut(),
				dacl.as_ptr().cast(),
				null_mut(),
			)
		};
		if status == 0 {
			NativeOwnerOnlySecurityResult::success()
		} else {
			NativeOwnerOnlySecurityResult::failure("acl_apply_failed")
		}
	}
	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let mut handle = match open_exact(path, kind, WRITE_DAC | READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		let repair_owner = match inspect_owner_only_acl(handle.target, kind, &sid) {
			Ok(OwnerOnlyAclState::Clean) => false,
			Ok(OwnerOnlyAclState::OwnerMismatch) => true,
			Ok(OwnerOnlyAclState::RepairableMismatch) => false,
			Ok(OwnerOnlyAclState::UnsafeMismatch) => {
				return NativeOwnerOnlySecurityResult::failure("acl_verify_failed");
			},
			Err(code) => return NativeOwnerOnlySecurityResult::failure(code),
		};
		if repair_owner {
			let owner_handle = match open_exact(path, kind, WRITE_OWNER | WRITE_DAC | READ_CONTROL) {
				Ok(handle) => handle,
				Err(result) => return result,
			};
			match same_file_identity(handle.target, owner_handle.target) {
				Ok(true) => handle = owner_handle,
				Ok(false) => return NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
				Err(result) => return result,
			}
		}
		let applied = set_owner_only_acl(handle.target, kind, &sid, repair_owner);
		if !applied.ok {
			return applied;
		}
		let verified = verify_owner_only_handle(handle.target, kind);
		let reopened = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		match same_file_identity(handle.target, reopened.target) {
			Ok(true) => verified,
			Ok(false) => NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
			Err(result) => result,
		}
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		verify_owner_only_handle(handle.target, kind)
	}
	pub(super) fn verify_owner_only_path_security_expected(
		path: &Path,
		kind: &str,
		expected_dev: u64,
		expected_ino: u64,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut initial_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut initial_information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&initial_information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		let verified = verify_owner_only_handle(handle.target, kind);
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut final_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut final_information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&final_information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		let reopened = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let mut rebound_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(reopened.target, &mut rebound_information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&rebound_information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		verified
	}

	fn expected_handle_identity_matches(
		information: &BY_HANDLE_FILE_INFORMATION,
		expected_dev: u64,
		expected_ino: u64,
	) -> bool {
		let ino =
			(u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
		u64::from(information.dwVolumeSerialNumber) == expected_dev && ino == expected_ino
	}

	pub(super) fn repair_owner_only_path_security_expected(
		path: &Path,
		kind: &str,
		expected_dev: u64,
		expected_ino: u64,
	) -> NativeOwnerOnlySecurityResult {
		let mut handle = match open_exact(path, kind, WRITE_DAC | READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		let (requires_apply, repair_owner) = match inspect_owner_only_acl(handle.target, kind, &sid) {
			Ok(OwnerOnlyAclState::Clean) => (false, false),
			Ok(OwnerOnlyAclState::OwnerMismatch) => (true, true),
			Ok(OwnerOnlyAclState::RepairableMismatch) => (true, false),
			Ok(OwnerOnlyAclState::UnsafeMismatch) => {
				return NativeOwnerOnlySecurityResult::failure("acl_verify_failed");
			},
			Err(code) => return NativeOwnerOnlySecurityResult::failure(code),
		};
		if repair_owner {
			let owner_handle = match open_exact(path, kind, WRITE_OWNER | WRITE_DAC | READ_CONTROL) {
				Ok(handle) => handle,
				Err(result) => return result,
			};
			let mut owner_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(owner_handle.target, &mut owner_information) } == 0
			{
				return NativeOwnerOnlySecurityResult::failure(last_error_code());
			}
			if !expected_handle_identity_matches(&owner_information, expected_dev, expected_ino) {
				return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
			}
			handle = owner_handle;
		}
		if requires_apply {
			let applied = set_owner_only_acl(handle.target, kind, &sid, repair_owner);
			if !applied.ok {
				return applied;
			}
		}
		let mut final_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle.target, &mut final_information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&final_information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		let verified = verify_owner_only_handle(handle.target, kind);
		let reopened = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let mut rebound_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(reopened.target, &mut rebound_information) } == 0 {
			return NativeOwnerOnlySecurityResult::failure(last_error_code());
		}
		if !expected_handle_identity_matches(&rebound_information, expected_dev, expected_ino) {
			return NativeOwnerOnlySecurityResult::failure("identity_mismatch");
		}
		verified
	}

	fn uv_osfhandle(caller_fd: i32) -> Option<isize> {
		let module = unsafe { GetModuleHandleW(null()) };
		if module.is_null() {
			return None;
		}
		let procedure = unsafe { GetProcAddress(module, b"uv_get_osfhandle\0".as_ptr()) };
		if procedure.is_null() {
			return None;
		}
		// SAFETY: `uv_get_osfhandle` is libuv's C ABI descriptor conversion exported
		// by Node-compatible hosts. Its descriptor table belongs to the host that
		// supplied `caller_fd`, unlike this addon's CRT table.
		let conversion: UvGetOsfhandle = unsafe { std::mem::transmute(procedure) };
		Some(unsafe { conversion(caller_fd) })
	}

	fn retained_caller_handle(caller_fd: i32) -> Result<HeldExact, NativeOwnerOnlySecurityResult> {
		if caller_fd < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		}
		let Some(raw_handle) = uv_osfhandle(caller_fd) else {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		};
		if raw_handle == -1 {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		}
		let handle = raw_handle as HANDLE;
		if handle.is_null() || handle == INVALID_HANDLE_VALUE {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		}
		let process = unsafe { GetCurrentProcess() };
		let mut retained = INVALID_HANDLE_VALUE;
		if unsafe {
			DuplicateHandle(process, handle, process, &mut retained, 0, 0, DUPLICATE_SAME_ACCESS)
		} == 0
		{
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		}
		Ok(HeldExact { target: retained, ancestors: Vec::new() })
	}

	fn same_file_identity(
		left: HANDLE,
		right: HANDLE,
	) -> Result<bool, NativeOwnerOnlySecurityResult> {
		let mut left_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		let mut right_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(left, &mut left_information) } == 0
			|| unsafe { GetFileInformationByHandle(right, &mut right_information) } == 0
		{
			return Err(NativeOwnerOnlySecurityResult::failure("identity_unavailable"));
		}
		Ok(left_information.dwVolumeSerialNumber == right_information.dwVolumeSerialNumber
			&& left_information.nFileIndexHigh == right_information.nFileIndexHigh
			&& left_information.nFileIndexLow == right_information.nFileIndexLow)
	}

	fn checked_caller_handle(
		path: &Path,
		kind: &str,
		caller_fd: i32,
		desired_access: u32,
	) -> Result<(HeldExact, HeldExact), NativeOwnerOnlySecurityResult> {
		let caller = retained_caller_handle(caller_fd)?;
		let path_handle = open_exact(path, kind, desired_access)?;
		if !same_file_identity(path_handle.target, caller.target)? {
			return Err(NativeOwnerOnlySecurityResult::failure("identity_mismatch"));
		}
		Ok((path_handle, caller))
	}

	pub(super) fn apply_owner_only_fd_security(
		path: &Path,
		kind: &str,
		caller_fd: i32,
	) -> NativeOwnerOnlySecurityResult {
		let (mut path_handle, caller) =
			match checked_caller_handle(path, kind, caller_fd, READ_CONTROL | WRITE_DAC) {
				Ok(handles) => handles,
				Err(result) => return result,
			};
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		let (requires_apply, repair_owner) =
			match inspect_owner_only_acl(path_handle.target, kind, &sid) {
				Ok(OwnerOnlyAclState::Clean) => (false, false),
				Ok(OwnerOnlyAclState::OwnerMismatch) => (true, true),
				Ok(OwnerOnlyAclState::RepairableMismatch) => (true, false),
				Ok(OwnerOnlyAclState::UnsafeMismatch) => {
					return NativeOwnerOnlySecurityResult::failure("acl_verify_failed");
				},
				Err(code) => return NativeOwnerOnlySecurityResult::failure(code),
			};
		if repair_owner {
			let owner_handle = match open_exact(path, kind, READ_CONTROL | WRITE_DAC | WRITE_OWNER) {
				Ok(handle) => handle,
				Err(result) => return result,
			};
			match same_file_identity(owner_handle.target, caller.target) {
				Ok(true) => path_handle = owner_handle,
				Ok(false) => return NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
				Err(result) => return result,
			}
		}
		if requires_apply {
			let applied = set_owner_only_acl(path_handle.target, kind, &sid, repair_owner);
			if !applied.ok {
				return applied;
			}
		}
		match same_file_identity(path_handle.target, caller.target) {
			Ok(true) => {},
			Ok(false) => return NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
			Err(result) => return result,
		}
		let reopened = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		match same_file_identity(reopened.target, caller.target) {
			Ok(true) => verify_owner_only_handle(path_handle.target, kind),
			Ok(false) => NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
			Err(result) => result,
		}
	}

	pub(super) fn verify_owner_only_fd_security(
		path: &Path,
		kind: &str,
		caller_fd: i32,
	) -> NativeOwnerOnlySecurityResult {
		let (path_handle, caller) = match checked_caller_handle(path, kind, caller_fd, READ_CONTROL) {
			Ok(handles) => handles,
			Err(result) => return result,
		};
		let verified = verify_owner_only_handle(path_handle.target, kind);
		match same_file_identity(path_handle.target, caller.target) {
			Ok(true) => {},
			Ok(false) => return NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
			Err(result) => return result,
		}
		let reopened = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		match same_file_identity(reopened.target, caller.target) {
			Ok(true) => verified,
			Ok(false) => NativeOwnerOnlySecurityResult::failure("identity_mismatch"),
			Err(result) => result,
		}
	}
	#[cfg(test)]
	mod tests {
		use super::{FILE_ALL_ACCESS, FILE_READ_DATA, GENERIC_ALL, owner_only_ace_mask_is_safe};

		#[test]
		fn owner_only_ace_mask_accepts_legacy_and_current_full_access_masks() {
			assert!(owner_only_ace_mask_is_safe(GENERIC_ALL));
			assert!(owner_only_ace_mask_is_safe(FILE_ALL_ACCESS));
		}

		#[test]
		fn owner_only_ace_mask_rejects_partial_and_combined_masks() {
			assert!(!owner_only_ace_mask_is_safe(FILE_ALL_ACCESS & !FILE_READ_DATA));
			assert!(!owner_only_ace_mask_is_safe(GENERIC_ALL | FILE_READ_DATA));
		}
	}
	fn hex_digest(digest: [u8; 32]) -> String {
		digest.iter().map(|byte| format!("{byte:02x}")).collect()
	}

	fn directory_names(handle: HANDLE) -> Result<Vec<(String, OsString)>, &'static str> {
		let mut names = Vec::new();
		let mut restart_scan = 1u8;
		loop {
			let mut buffer = vec![0u8; 64 * 1024];
			// SAFETY: zero is a valid initial NT I/O status block and the kernel writes it
			// only through this exclusive, properly aligned mutable reference.
			let mut status: IoStatusBlock = unsafe { std::mem::zeroed() };
			// SAFETY: `handle` remains open, `buffer` is writable for its checked u32
			// length, and `status` outlives the synchronous NT call.
			let result = unsafe {
				NtQueryDirectoryFile(
					handle,
					null_mut(),
					null_mut(),
					null_mut(),
					&mut status,
					buffer.as_mut_ptr().cast(),
					buffer.len() as u32,
					FILE_ID_BOTH_DIRECTORY_INFORMATION,
					0,
					null_mut(),
					restart_scan,
				)
			};
			restart_scan = 0;
			if result == STATUS_NO_MORE_FILES {
				return Ok(names);
			}
			if result < 0 && result != STATUS_BUFFER_OVERFLOW {
				return Err("io_error");
			}
			if status.information > buffer.len() {
				return Err("io_error");
			}
			let used = status.information;
			if used == 0 {
				return if result == 0 {
					Ok(names)
				} else {
					Err("io_error")
				};
			}
			let minimum = std::mem::offset_of!(FileIdBothDirectoryInformation, file_name);
			let name_length_offset =
				std::mem::offset_of!(FileIdBothDirectoryInformation, file_name_length);
			let mut offset = 0usize;
			while offset < used {
				let available = used.checked_sub(offset).ok_or("io_error")?;
				if available < minimum {
					return Err("io_error");
				}
				let next = u32::from_le_bytes(
					buffer[offset..offset.checked_add(size_of::<u32>()).ok_or("io_error")?]
						.try_into()
						.map_err(|_| "io_error")?,
				) as usize;
				let record_size = if next == 0 {
					available
				} else if next >= minimum && next <= available {
					next
				} else {
					return Err("io_error");
				};
				let length_start = offset.checked_add(name_length_offset).ok_or("io_error")?;
				let length_end = length_start
					.checked_add(size_of::<u32>())
					.ok_or("io_error")?;
				let length = u32::from_le_bytes(
					buffer
						.get(length_start..length_end)
						.ok_or("io_error")?
						.try_into()
						.map_err(|_| "io_error")?,
				) as usize;
				if length % size_of::<u16>() != 0 || length > record_size - minimum {
					return Err("io_error");
				}
				let name_start = offset.checked_add(minimum).ok_or("io_error")?;
				let name_end = name_start.checked_add(length).ok_or("io_error")?;
				let units = buffer
					.get(name_start..name_end)
					.ok_or("io_error")?
					.chunks_exact(size_of::<u16>())
					.map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
					.collect::<Vec<_>>();
				let name = String::from_utf16(&units).map_err(|_| "not_utf8")?;
				if name != "." && name != ".." {
					names.push((name, OsString::from_wide(&units)));
				}
				if next == 0 {
					break;
				}
				offset = offset.checked_add(next).ok_or("io_error")?;
			}
		}
	}

	fn tree_entry(
		handle: HANDLE,
		relative_path: String,
		kind: &str,
	) -> Result<NativeDirectoryTreeEntry, &'static str> {
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			return Err(last_error_code());
		}
		let attributes = information.dwFileAttributes;
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return Err("reparse_point");
		}
		let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
		if (kind == "directory") != is_directory {
			return Err("unsupported_entry");
		}
		if !is_directory && information.nNumberOfLinks != 1 {
			return Err("hard_link_unsupported");
		}
		let ino =
			(u64::from(information.nFileIndexHigh) << 32) | u64::from(information.nFileIndexLow);
		let size = (u64::from(information.nFileSizeHigh) << 32) | u64::from(information.nFileSizeLow);
		let filetime = (u64::from(information.ftLastWriteTime.dwHighDateTime) << 32)
			| u64::from(information.ftLastWriteTime.dwLowDateTime);
		let mtime_ns = i128::from(filetime) * 100 - 11_644_473_600_000_000_000i128;
		Ok(NativeDirectoryTreeEntry {
			relative_path,
			kind: kind.to_owned(),
			dev: u64::from(information.dwVolumeSerialNumber).to_string(),
			ino: ino.to_string(),
			nlink: information.nNumberOfLinks.to_string(),
			size: size.to_string(),
			mtime_ns: mtime_ns.to_string(),
			ctime_ns: mtime_ns.to_string(),
			sha256: if is_directory {
				None
			} else {
				Some(hex_digest(digest_handle(handle)?))
			},
		})
	}

	fn snapshot_tree_handle(
		handle: HANDLE,
		relative: &str,
		entries: &mut Vec<NativeDirectoryTreeEntry>,
	) -> Result<(), &'static str> {
		entries.push(tree_entry(handle, relative.to_owned(), "directory")?);
		let mut names = directory_names(handle)?;
		names.sort_by(|left, right| left.0.cmp(&right.0));
		for (name, name_os) in names {
			let child_relative = if relative.is_empty() {
				name
			} else {
				format!("{relative}/{name}")
			};
			let file = open_relative(handle, &name_os, FILE_READ_ATTRIBUTES | FILE_READ_DATA, false);
			let (child, kind) = match file {
				Ok(child) => (child, "file"),
				Err(_) => (
					open_relative(handle, &name_os, FILE_READ_ATTRIBUTES | FILE_READ_DATA, true)?,
					"directory",
				),
			};
			let attributes = match handle_attributes(child) {
				Ok(value) => value,
				Err(code) => {
					unsafe { CloseHandle(child) };
					return Err(code);
				},
			};
			let result = if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				Err("reparse_point")
			} else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
				snapshot_tree_handle(child, &child_relative, entries)
			} else {
				entries.push(tree_entry(child, child_relative, kind)?);
				Ok(())
			};
			unsafe { CloseHandle(child) };
			result?;
		}
		Ok(())
	}

	fn tree_entry_matches(
		handle: HANDLE,
		expected: &NativeDirectoryTreeEntry,
	) -> Result<bool, &'static str> {
		let attributes = handle_attributes(handle)?;
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return Ok(false);
		}
		let kind = if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
			"directory"
		} else {
			"file"
		};
		let actual = tree_entry(handle, expected.relative_path.clone(), kind)?;
		Ok(actual.kind == expected.kind
			&& actual.dev == expected.dev
			&& actual.ino == expected.ino
			&& (kind == "directory"
				|| (actual.size == expected.size
					&& actual.mtime_ns == expected.mtime_ns
					&& actual.sha256 == expected.sha256)))
	}

	fn expected_tree_entry<'a>(
		expected: &'a [NativeDirectoryTreeEntry],
		relative: &str,
	) -> Option<&'a NativeDirectoryTreeEntry> {
		expected
			.iter()
			.find(|entry| entry.relative_path == relative)
	}

	fn tree_quarantine_name(expected: &NativeDirectoryTreeEntry) -> String {
		let mut material = expected.relative_path.as_bytes().to_vec();
		material.push(0);
		material.extend_from_slice(expected.dev.as_bytes());
		material.push(0);
		material.extend_from_slice(expected.ino.as_bytes());
		format!(".pi-tree-detached-{}", hex_digest(sha256(&material)))
	}

	fn expected_quarantined_tree_entry<'a>(
		expected: &'a [NativeDirectoryTreeEntry],
		relative: &str,
		name: &str,
	) -> Option<&'a NativeDirectoryTreeEntry> {
		let mut matching = expected.iter().filter(|entry| {
			let parent_matches = entry
				.relative_path
				.rsplit_once('/')
				.map_or(relative.is_empty(), |(parent, _)| parent == relative);
			!entry.relative_path.is_empty() && parent_matches && tree_quarantine_name(entry) == name
		});
		let entry = matching.next()?;
		matching.next().is_none().then_some(entry)
	}

	fn quarantine_tree_child(
		handle: HANDLE,
		parent: HANDLE,
		expected: &NativeDirectoryTreeEntry,
	) -> Result<(), &'static str> {
		let name: Vec<u16> = tree_quarantine_name(expected).encode_utf16().collect();
		rename_handle(handle, parent, &name, false)
	}

	fn set_handle_attributes(handle: HANDLE, attributes: u32) -> Result<(), &'static str> {
		let mut basic = FILE_BASIC_INFO {
			CreationTime:   0,
			LastAccessTime: 0,
			LastWriteTime:  0,
			ChangeTime:     0,
			FileAttributes: attributes,
		};
		if unsafe {
			SetFileInformationByHandle(
				handle,
				FileBasicInfo,
				(&raw mut basic).cast(),
				size_of::<FILE_BASIC_INFO>() as u32,
			)
		} == 0
		{
			return Err(last_error_code());
		}
		Ok(())
	}

	fn delete_handle(handle: HANDLE) -> Result<(), &'static str> {
		let original_attributes = handle_attributes(handle)?;
		let readonly = original_attributes & FILE_ATTRIBUTE_READONLY != 0;
		if readonly {
			set_handle_attributes(handle, original_attributes & !FILE_ATTRIBUTE_READONLY)?;
		}
		let mut disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
		if unsafe {
			SetFileInformationByHandle(
				handle,
				FileDispositionInfo,
				(&raw mut disposition).cast(),
				size_of::<FILE_DISPOSITION_INFO>() as u32,
			)
		} == 0
		{
			let code = last_error_code();
			if readonly && set_handle_attributes(handle, original_attributes).is_err() {
				return Err("restore_failed");
			}
			return Err(code);
		}
		Ok(())
	}

	/// Validate the complete retained tree before any handle rename or deletion.
	/// Entries absent from the snapshot subset may have been removed by an
	/// earlier attempt; every entry that remains must still map uniquely to its
	/// logical snapshot identity, including deterministic child quarantine
	/// names.
	fn validate_tree_handle(
		handle: HANDLE,
		relative: &str,
		expected: &[NativeDirectoryTreeEntry],
	) -> Result<(), &'static str> {
		let mut names = directory_names(handle)?;
		names.sort_by(|left, right| left.0.cmp(&right.0));
		let mut seen = std::collections::BTreeSet::new();
		for (name, name_os) in names {
			let direct_relative = if relative.is_empty() {
				name.clone()
			} else {
				format!("{relative}/{name}")
			};
			let expected_direct = expected_tree_entry(expected, &direct_relative);
			let expected_quarantined = expected_quarantined_tree_entry(expected, relative, &name);
			let expected_child = match (expected_direct, expected_quarantined) {
				(Some(entry), None) | (None, Some(entry)) => entry,
				_ => return Err("identity_mismatch"),
			};
			if !seen.insert(expected_child.relative_path.clone()) {
				return Err("identity_mismatch");
			}
			let directory = expected_child.kind == "directory";
			let child =
				open_relative(handle, &name_os, FILE_READ_ATTRIBUTES | FILE_READ_DATA, directory)?;
			let result = if !tree_entry_matches(child, expected_child)? {
				Err("identity_mismatch")
			} else if directory {
				validate_tree_handle(child, &expected_child.relative_path, expected)
			} else {
				Ok(())
			};
			unsafe { CloseHandle(child) };
			result?;
		}
		Ok(())
	}

	fn remove_tree_handle(
		handle: HANDLE,
		relative: &str,
		expected: &[NativeDirectoryTreeEntry],
	) -> Result<(), &'static str> {
		let mut names = directory_names(handle)?;
		names.sort_by(|left, right| left.0.cmp(&right.0));
		let mut seen = std::collections::BTreeSet::new();
		for (name, name_os) in names {
			let direct_relative = if relative.is_empty() {
				name.clone()
			} else {
				format!("{relative}/{name}")
			};
			let expected_child = expected_tree_entry(expected, &direct_relative)
				.or_else(|| expected_quarantined_tree_entry(expected, relative, &name))
				.ok_or("identity_mismatch")?;
			if !seen.insert(expected_child.relative_path.clone()) {
				return Err("identity_mismatch");
			}
			let directory = expected_child.kind == "directory";
			let child = if directory {
				open_relative(
					handle,
					&name_os,
					FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | 0x0001_0000,
					true,
				)?
			} else {
				open_relative_with_share(
					handle,
					&name_os,
					FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | 0x0001_0000,
					false,
					FILE_SHARE_READ,
				)?
			};
			if !tree_entry_matches(child, expected_child)? {
				unsafe { CloseHandle(child) };
				return Err("identity_mismatch");
			}
			let already_quarantined = name == tree_quarantine_name(expected_child);
			if !already_quarantined {
				quarantine_tree_child(child, handle, expected_child)?;
			}
			if !tree_entry_matches(child, expected_child)? {
				unsafe { CloseHandle(child) };
				return Err("identity_mismatch");
			}
			let result = if directory {
				remove_tree_handle(child, &expected_child.relative_path, expected)
					.and_then(|()| delete_handle(child))
			} else {
				delete_handle(child)
			};
			unsafe { CloseHandle(child) };
			result?;
		}
		Ok(())
	}

	pub(super) fn snapshot_directory_tree(path: &Path) -> NativeDirectoryTreeResult {
		let root = match open_exact(path, "directory", FILE_READ_ATTRIBUTES | FILE_READ_DATA) {
			Ok(root) => root,
			Err(result) => {
				return NativeDirectoryTreeResult::failure(
					result.code.as_deref().unwrap_or("io_error"),
				);
			},
		};
		let mut entries = Vec::new();
		match snapshot_tree_handle(root.target, "", &mut entries) {
			Ok(()) if !entries.is_empty() => {
				NativeDirectoryTreeResult::success(NativeDirectoryTreeSnapshot {
					root_dev: entries[0].dev.clone(),
					root_ino: entries[0].ino.clone(),
					entries,
				})
			},
			Ok(()) => NativeDirectoryTreeResult::failure("identity_mismatch"),
			Err(code) => NativeDirectoryTreeResult::failure(code),
		}
	}

	pub(super) fn exact_remove_directory_tree(
		path: &Path,
		expected: &NativeDirectoryTreeSnapshot,
		expected_parent: Option<(u64, u64)>,
	) -> NativeExactUnlinkResult {
		let planned_path = path.to_string_lossy().into_owned();
		let final_path = format!("{planned_path}.removing");
		let final_name: Vec<u16> = match path.file_name() {
			Some(name) => {
				let mut value: Vec<u16> = name.encode_wide().collect();
				value.extend(".removing".encode_utf16());
				value
			},
			None => return NativeExactUnlinkResult::failure("io_error"),
		};
		let mut final_candidate = PathBuf::from(path);
		final_candidate.set_file_name(OsString::from_wide(&final_name));
		let input_is_final = planned_path.ends_with(".removing");
		let (root, retained_path, already_final) = match open_exact(
			path,
			"directory",
			FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | 0x0001_0000,
		) {
			Ok(root) => (root, planned_path.clone(), input_is_final),
			Err(result) if !input_is_final && result.code.as_deref() == Some("not_found") => {
				match open_exact(
					&final_candidate,
					"directory",
					FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | 0x0001_0000,
				) {
					Ok(root) => (root, final_path.clone(), true),
					Err(result) => {
						return NativeExactUnlinkResult {
							ok: false,
							code: result.code,
							payload_durable: None,
							detached_path: None,
							retained_successor_path: None,
							retained_placeholder_path: None,
							retained_unknown_path: None,
							windows_error_code: None,
						};
					},
				}
			},
			Err(result) => {
				return NativeExactUnlinkResult {
					ok: false,
					code: result.code,
					payload_durable: None,
					detached_path: None,
					retained_successor_path: None,
					retained_placeholder_path: None,
					retained_unknown_path: None,
					windows_error_code: None,
				};
			},
		};
		let root_entry = match tree_entry(root.target, String::new(), "directory") {
			Ok(entry) => entry,
			Err(code) => return NativeExactUnlinkResult::detached_failure(code, retained_path),
		};
		if root_entry.dev != expected.root_dev || root_entry.ino != expected.root_ino {
			return NativeExactUnlinkResult::detached_failure("identity_mismatch", retained_path);
		}
		if let Err(code) = validate_tree_handle(root.target, "", &expected.entries) {
			return NativeExactUnlinkResult::detached_failure(code, retained_path);
		}
		let parent = *root.ancestors.last().expect("directory parent retained");
		if let Some((expected_parent_dev, expected_parent_ino)) = expected_parent {
			let mut parent_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
			if unsafe { GetFileInformationByHandle(parent, &mut parent_information) } == 0
				|| u64::from(parent_information.dwVolumeSerialNumber) != expected_parent_dev
				|| ((u64::from(parent_information.nFileIndexHigh) << 32)
					| u64::from(parent_information.nFileIndexLow))
					!= expected_parent_ino
			{
				return NativeExactUnlinkResult::detached_failure("parent_mismatch", retained_path);
			}
		}
		match remove_tree_handle(root.target, "", &expected.entries) {
			Ok(()) if !already_final => match rename_handle(root.target, parent, &final_name, false) {
				Ok(()) => match tree_entry(root.target, String::new(), "directory") {
					Ok(entry) if entry.dev == expected.root_dev && entry.ino == expected.root_ino => {
						match delete_handle(root.target) {
							Ok(()) => NativeExactUnlinkResult::success(),
							Err(code) => NativeExactUnlinkResult::detached_failure(code, final_path),
						}
					},
					Ok(_) => NativeExactUnlinkResult::detached_failure("identity_mismatch", final_path),
					Err(code) => NativeExactUnlinkResult::detached_failure(code, final_path),
				},
				Err(code) => NativeExactUnlinkResult::detached_failure(code, planned_path),
			},
			Ok(()) => match delete_handle(root.target) {
				Ok(()) => NativeExactUnlinkResult::success(),
				Err(code) => NativeExactUnlinkResult::detached_failure(code, retained_path),
			},
			Err(code) => NativeExactUnlinkResult::detached_failure(code, retained_path),
		}
	}

	const FILE_CREATE: u32 = 2;
	const FILE_OPEN_IF: u32 = 3;
	const FILE_ADD_SUBDIRECTORY: u32 = 0x0004;

	fn skill_write_error() -> &'static str {
		match unsafe { GetLastError() } {
			2 | 3 => "not_found",
			5 | 32 => "permission_denied",
			112 => "no_space",
			206 => "name_too_long",
			223 => "content_too_large",
			_ => "io_error",
		}
	}

	fn skill_directory_matches_volume(
		handle: HANDLE,
		canonical_volume: &str,
	) -> Result<(), &'static str> {
		let canonical = final_path(handle)?;
		if canonical.starts_with(canonical_volume) {
			Ok(())
		} else {
			Err("identity_unavailable")
		}
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained parent handle remains live across the no-follow child open and \
		          identity check"
	)]
	fn open_or_create_skill_directory(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		acl_access: bool,
	) -> Result<HANDLE, &'static str> {
		// DACL ownership rights are needed only when hardening a private user
		// directory. Project-scope writes must remain usable by collaborators who
		// can create files but are not allowed to replace the owner or DACL.
		let access = FILE_READ_ATTRIBUTES
			| FILE_TRAVERSE
			| if acl_access {
				READ_CONTROL | WRITE_DAC | WRITE_OWNER
			} else {
				0
			};
		let handle = match open_relative(parent, name, access, true) {
			Ok(handle) => handle,
			Err(_) => open_relative_with_disposition_status(
				parent,
				name,
				access | FILE_ADD_SUBDIRECTORY,
				true,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				FILE_OPEN_IF,
			)
			.map_err(ntstatus_code)?,
		};
		let attributes = match handle_attributes(handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe { CloseHandle(handle) };
				return Err(code);
			},
		};
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			unsafe { CloseHandle(handle) };
			return Err("reparse_point");
		}
		if attributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
			unsafe { CloseHandle(handle) };
			return Err("not_directory");
		}
		let rebound = match open_relative(parent, name, access, true) {
			Ok(rebound) => rebound,
			Err(_) => {
				unsafe { CloseHandle(handle) };
				return Err("identity_mismatch");
			},
		};
		let same = handles_same_object_checked(handle, rebound).unwrap_or(false);
		unsafe { CloseHandle(rebound) };
		if !same {
			unsafe { CloseHandle(handle) };
			return Err("identity_mismatch");
		}
		Ok(handle)
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained volume and directory handles own every component of the walk"
	)]
	fn open_or_create_skill_root(
		path: &Path,
		acl_access: bool,
	) -> Result<(HeldExact, String, Vec<OsString>), &'static str> {
		let (root, names) = absolute_components(path)?;
		let root_handle = open_path(&root, true, FILE_READ_ATTRIBUTES | FILE_TRAVERSE)?;
		let root_attributes = match handle_attributes(root_handle) {
			Ok(attributes) => attributes,
			Err(code) => {
				unsafe { CloseHandle(root_handle) };
				return Err(code);
			},
		};
		if root_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			unsafe { CloseHandle(root_handle) };
			return Err("reparse_point");
		}
		let canonical_volume = match final_path(root_handle) {
			Ok(path) => path,
			Err(code) => {
				unsafe { CloseHandle(root_handle) };
				return Err(code);
			},
		};
		let mut authority = HeldExact { target: root_handle, ancestors: Vec::new() };
		for (index, name) in names.iter().enumerate() {
			let child = match open_or_create_skill_directory(
				authority.target,
				name,
				acl_access && index + 1 == names.len(),
			) {
				Ok(child) => child,
				Err(code) => return Err(code),
			};
			if let Err(code) = skill_directory_matches_volume(child, &canonical_volume) {
				unsafe { CloseHandle(child) };
				return Err(code);
			}
			authority.retain_child(child);
		}
		Ok((authority, canonical_volume, names))
	}

	/// Re-open every retained root component from its already-held parent handle
	/// and compare it with the retained child.  A replacement at any public
	/// component therefore fails closed instead of publishing into a detached
	/// directory that is no longer reachable from `root_path`.
	fn revalidate_skill_root(authority: &HeldExact, names: &[OsString]) -> Result<(), &'static str> {
		if names.len() != authority.ancestors.len() {
			return Err("identity_mismatch");
		}
		let mut parent = authority
			.ancestors
			.first()
			.copied()
			.ok_or("identity_mismatch")?;
		for (index, name) in names.iter().enumerate() {
			let child = open_relative(parent, name, FILE_READ_ATTRIBUTES | FILE_TRAVERSE, true)?;
			let expected = if index + 1 == names.len() {
				authority.target
			} else {
				authority.ancestors[index + 1]
			};
			let same = handles_same_object_checked(child, expected).unwrap_or(false);
			unsafe { CloseHandle(child) };
			if !same {
				return Err("identity_mismatch");
			}
			parent = expected;
		}
		Ok(())
	}

	fn revalidate_skill_directory(
		authority: &HeldExact,
		names: &[OsString],
		skill_name: &OsString,
		skill_handle: HANDLE,
	) -> Result<(), &'static str> {
		revalidate_skill_root(authority, names)?;
		let parent = authority.parent().ok_or("identity_mismatch")?;
		let rebound = open_relative(parent, skill_name, FILE_READ_ATTRIBUTES | FILE_TRAVERSE, true)?;
		let same = handles_same_object_checked(rebound, skill_handle).unwrap_or(false);
		unsafe { CloseHandle(rebound) };
		if same {
			Ok(())
		} else {
			Err("identity_mismatch")
		}
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained skill-directory handle remains live through final identity validation"
	)]
	fn validate_skill_file_handle(handle: HANDLE) -> Result<(), &'static str> {
		let attributes = handle_attributes(handle)?;
		if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return Err("reparse_point");
		}
		if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
			return Err("not_regular_file");
		}
		let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
			return Err(last_error_code());
		}
		if information.nNumberOfLinks != 1 {
			return Err("hard_link");
		}
		Ok(())
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained skill-directory handle remains live through final no-follow \
		          inspection"
	)]
	fn inspect_existing_skill_file(
		parent: HANDLE,
		name: &std::ffi::OsStr,
	) -> Result<bool, &'static str> {
		let file = match open_relative_with_disposition_status(
			parent,
			name,
			FILE_READ_ATTRIBUTES | FILE_READ_DATA,
			false,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			FILE_OPEN,
		) {
			Ok(file) => file,
			Err(status) if ntstatus_code(status) == "not_found" => return Ok(false),
			Err(status) => return Err(ntstatus_code(status)),
		};
		let result = validate_skill_file_handle(file).map(|()| true);
		unsafe { CloseHandle(file) };
		result
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained skill-directory handle owns each unique private file name"
	)]
	fn create_private_skill_file(
		parent: HANDLE,
		acl_access: bool,
	) -> Result<(HANDLE, Vec<u16>), &'static str> {
		for _ in 0..16 {
			let sequence = NEXT_SECURE_SKILL_TEMP_ID.fetch_add(1, Ordering::Relaxed);
			let name = OsString::from(format!(".gjc-skill-write-{}-{}", std::process::id(), sequence));
			// The retained staging handle is written through directly below. Keep
			// FILE_WRITE_DATA explicit here: FILE_WRITE_ATTRIBUTES only permits
			// metadata changes and makes the first payload write fail closed.
			let staging_access = FILE_READ_ATTRIBUTES
				| FILE_WRITE_ATTRIBUTES
				| FILE_READ_DATA
				| FILE_WRITE_DATA
				| if acl_access {
					READ_CONTROL | WRITE_DAC | WRITE_OWNER
				} else {
					0
				} | 0x0001_0000;
			let file = match open_relative_with_disposition_status(
				parent,
				&name,
				staging_access,
				false,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				FILE_CREATE,
			) {
				Ok(file) => file,
				Err(status) if status as u32 == 0xc000_0035 => continue,
				Err(status) => return Err(ntstatus_code(status)),
			};
			if let Err(code) = validate_skill_file_handle(file) {
				let cleanup = cleanup_private_skill_file(file);
				unsafe { CloseHandle(file) };
				return Err(cleanup.err().unwrap_or(code));
			}
			return Ok((file, name.encode_wide().collect()));
		}
		Err("race_limit")
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "the retained writable file handle is the only mutation authority"
	)]
	fn truncate_and_write_skill_file(handle: HANDLE, content: &[u8]) -> Result<(), &'static str> {
		if unsafe { SetFilePointerEx(handle, 0, null_mut(), FILE_BEGIN) } == 0 {
			return Err(skill_write_error());
		}
		if unsafe { SetEndOfFile(handle) } == 0 {
			return Err(skill_write_error());
		}
		let mut offset = 0usize;
		while offset < content.len() {
			let chunk = (content.len() - offset).min(u32::MAX as usize);
			let mut written = 0u32;
			if unsafe {
				WriteFile(
					handle,
					content[offset..offset + chunk].as_ptr().cast(),
					chunk as u32,
					&mut written,
					null_mut(),
				)
			} == 0
			{
				return Err(skill_write_error());
			}
			if written == 0 {
				return Err("write_failed");
			}
			offset += written as usize;
		}
		Ok(())
	}

	enum SkillPublicationError {
		Pre(&'static str),
		Published { code: &'static str, target_verified: bool },
	}

	fn replace_skill_file_name(
		handle: HANDLE,
		parent: HANDLE,
		final_name: &[u16],
		authority: &HeldExact,
		path_names: &[OsString],
	) -> Result<(), SkillPublicationError> {
		#[cfg(test)]
		pause_secure_skill_write_before_rename_for_test();
		revalidate_skill_root(authority, path_names).map_err(SkillPublicationError::Pre)?;
		validate_skill_file_handle(handle).map_err(SkillPublicationError::Pre)?;
		rename_handle(handle, parent, final_name, true).map_err(SkillPublicationError::Pre)?;
		#[cfg(test)]
		pause_secure_skill_write_after_rename_for_test();
		// The rename is committed against the retained parent handle, which may
		// already be detached from `root_path`. Revalidate reachability before
		// accepting the publication or attempting target inspection.
		revalidate_skill_root(authority, path_names)
			.map_err(|code| SkillPublicationError::Published { code, target_verified: false })?;
		let published = open_relative_with_share(
			parent,
			OsStr::new("SKILL.md"),
			FILE_READ_ATTRIBUTES | FILE_READ_DATA,
			false,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		)
		.map_err(|code| SkillPublicationError::Published { code, target_verified: false })?;
		let same = handles_same_object_checked(handle, published).unwrap_or(false);
		let file_valid = validate_skill_file_handle(published).is_ok();
		let root_reachable = revalidate_skill_root(authority, path_names).is_ok();
		let validated = same && file_valid && root_reachable;
		unsafe { CloseHandle(published) };
		if validated {
			Ok(())
		} else {
			Err(SkillPublicationError::Published {
				code:            "identity_mismatch",
				target_verified: validated,
			})
		}
	}

	fn cleanup_private_skill_file(handle: HANDLE) -> Result<(), &'static str> {
		let scrubbed = truncate_and_write_skill_file(handle, &[]).is_ok();
		#[cfg(test)]
		let deleted = if FAIL_SECURE_SKILL_CLEANUP.swap(false, Ordering::Relaxed) {
			false
		} else {
			delete_handle(handle).is_ok()
		};
		#[cfg(not(test))]
		let deleted = delete_handle(handle).is_ok();
		if scrubbed && deleted {
			Ok(())
		} else {
			Err("cleanup_failed")
		}
	}

	fn remove_published_skill_file_if_exact(handle: HANDLE, parent: HANDLE) -> bool {
		let Ok(published) = open_relative_with_share(
			parent,
			OsStr::new("SKILL.md"),
			FILE_READ_ATTRIBUTES | FILE_READ_DATA,
			false,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		) else {
			return false;
		};
		let same = handles_same_object_checked(handle, published).unwrap_or(false);
		unsafe { CloseHandle(published) };
		if !same {
			return false;
		}
		delete_handle(handle).is_ok()
	}

	#[expect(
		clippy::undocumented_unsafe_blocks,
		reason = "all writes use the retained no-follow authority and are preceded by identity \
		          checks"
	)]
	pub(super) fn secure_write_skill_file(
		root_path: &Path,
		skill_name: &str,
		content: &str,
		file_mode: u32,
	) -> NativeSecureSkillWriteResult {
		let (mut skills, canonical_volume, mut path_names) =
			match open_or_create_skill_root(root_path, file_mode == 0o600) {
				Ok(value) => value,
				Err(code) => return NativeSecureSkillWriteResult::failure(code),
			};
		let skill_name = std::ffi::OsString::from(skill_name);
		let skill_handle =
			match open_or_create_skill_directory(skills.target, &skill_name, file_mode == 0o600) {
				Ok(handle) => handle,
				Err(code) => return NativeSecureSkillWriteResult::failure(code),
			};
		if let Err(code) = skill_directory_matches_volume(skill_handle, &canonical_volume) {
			unsafe { CloseHandle(skill_handle) };
			return NativeSecureSkillWriteResult::failure(code);
		}
		if file_mode == 0o600 {
			let sid = match current_user_sid() {
				Ok(sid) => sid,
				Err(()) => {
					unsafe { CloseHandle(skill_handle) };
					return NativeSecureSkillWriteResult::failure("acl_unavailable");
				},
			};
			let root_applied = set_owner_only_acl(skills.target, "directory", &sid, true);
			if !root_applied.ok {
				unsafe { CloseHandle(skill_handle) };
				return NativeSecureSkillWriteResult::failure(
					root_applied.code.as_deref().unwrap_or("acl_apply_failed"),
				);
			}
			let applied = set_owner_only_acl(skill_handle, "directory", &sid, true);
			if !applied.ok {
				unsafe { CloseHandle(skill_handle) };
				return NativeSecureSkillWriteResult::failure(
					applied.code.as_deref().unwrap_or("acl_apply_failed"),
				);
			}
		}
		skills.retain_child(skill_handle);
		// `retain_child` promotes the per-skill handle to `skills.target`; all
		// staging and publication operations must remain relative to that retained
		// handle rather than reopening the skills root by pathname.
		let skill_parent = skills.target;
		path_names.push(skill_name.clone());
		if revalidate_skill_root(&skills, &path_names).is_err() {
			return NativeSecureSkillWriteResult::failure("identity_mismatch");
		}
		let file_name = std::ffi::OsStr::new("SKILL.md");
		if let Err(code) = inspect_existing_skill_file(skill_parent, file_name) {
			return NativeSecureSkillWriteResult::failure(code);
		}
		let (file, _private_name) = match create_private_skill_file(skill_parent, file_mode == 0o600)
		{
			Ok(file) => file,
			Err(code) => return NativeSecureSkillWriteResult::failure(code),
		};
		if let Err(code) = truncate_and_write_skill_file(file, content.as_bytes()) {
			let cleanup = cleanup_private_skill_file(file);
			unsafe { CloseHandle(file) };
			return NativeSecureSkillWriteResult::failure(cleanup.err().unwrap_or(code));
		}
		if unsafe { FlushFileBuffers(file) } == 0 {
			let cleanup = cleanup_private_skill_file(file);
			unsafe { CloseHandle(file) };
			return NativeSecureSkillWriteResult::failure(
				cleanup.err().unwrap_or("durability_failed"),
			);
		}
		if file_mode == 0o600 {
			let sid = match current_user_sid() {
				Ok(sid) => sid,
				Err(()) => {
					let cleanup = cleanup_private_skill_file(file);
					unsafe { CloseHandle(file) };
					return NativeSecureSkillWriteResult::failure(
						cleanup.err().unwrap_or("acl_unavailable"),
					);
				},
			};
			let applied = set_owner_only_acl(file, "file", &sid, true);
			if !applied.ok {
				let cleanup = cleanup_private_skill_file(file);
				unsafe { CloseHandle(file) };
				return NativeSecureSkillWriteResult::failure(
					cleanup.err().unwrap_or("acl_apply_failed"),
				);
			}
			let verified = verify_owner_only_handle(file, "file");
			if !verified.ok {
				let cleanup = cleanup_private_skill_file(file);
				unsafe { CloseHandle(file) };
				return NativeSecureSkillWriteResult::failure(
					cleanup.err().unwrap_or("acl_verify_failed"),
				);
			}
		}
		let final_name: Vec<u16> = file_name.encode_wide().collect();
		if let Err(error) =
			replace_skill_file_name(file, skill_parent, &final_name, &skills, &path_names)
		{
			if let SkillPublicationError::Published { code, target_verified } = error {
				// `file` names the post-rename public object now. Never route it
				// through private cleanup: that helper truncates before deleting.
				let removed = remove_published_skill_file_if_exact(file, skill_parent);
				if !removed && target_verified {
					unsafe { CloseHandle(file) };
					return NativeSecureSkillWriteResult::success(
						root_path
							.join(&skill_name)
							.join(&file_name)
							.to_string_lossy()
							.into_owned(),
					);
				}
				unsafe { CloseHandle(file) };
				if !removed {
					return NativeSecureSkillWriteResult::failure("published_unverified");
				}
				return NativeSecureSkillWriteResult::failure(code);
			}
			let code = match error {
				SkillPublicationError::Pre(code) => {
					cleanup_private_skill_file(file).err().unwrap_or(code)
				},
				SkillPublicationError::Published { .. } => unreachable!(),
			};
			unsafe { CloseHandle(file) };
			return NativeSecureSkillWriteResult::failure(code);
		}
		// Recheck the retained root and per-skill binding after publication. The
		// post-rename verification runs before this caller resumes, but a concurrent
		// rename can still replace the skill directory during that final check.
		if revalidate_skill_root(&skills, &path_names).is_err() {
			unsafe { CloseHandle(file) };
			return NativeSecureSkillWriteResult::failure("identity_mismatch");
		}
		unsafe { CloseHandle(file) };
		NativeSecureSkillWriteResult::success(
			root_path
				.join(skill_name)
				.join(file_name)
				.to_string_lossy()
				.into_owned(),
		)
	}
}

#[cfg(not(any(unix, windows)))]
mod platform {
	use std::path::Path;

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeResult,
		NativeDirectoryTreeSnapshot, NativeExactUnlinkResult, NativeOwnerOnlySecurityResult,
		NativeSecureSkillWriteResult,
	};

	pub(super) fn secure_write_skill_file(
		_: &Path,
		_: &str,
		_: &str,
		_: u32,
	) -> NativeSecureSkillWriteResult {
		NativeSecureSkillWriteResult::failure("unsupported_platform")
	}

	pub(super) fn canonical_existing_directory_identity(
		_: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		NativeCanonicalDirectoryIdentity::failure("identity_unavailable")
	}
	pub(super) fn rename_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}
	pub(super) fn rename_directory_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}
	pub(super) fn link_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}
	pub(super) fn exact_unlink(_: &Path, _: &ExactFileIdentity) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("identity_unavailable")
	}
	pub(super) fn exact_unlink_direct(_: &Path, _: &ExactFileIdentity) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("identity_unavailable")
	}
	pub(super) fn exact_restore(
		_: &Path,
		_: &Path,
		_: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("identity_unavailable")
	}
	pub(super) fn snapshot_directory_tree(_: &Path) -> NativeDirectoryTreeResult {
		NativeDirectoryTreeResult::failure("tree_authority_unavailable")
	}
	pub(super) fn exact_remove_directory_tree(
		_: &Path,
		_: &NativeDirectoryTreeSnapshot,
		_: Option<(u64, u64)>,
	) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("tree_authority_unavailable")
	}
	pub(super) fn apply_owner_only_path_security(
		_: &Path,
		_: &str,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	pub(super) fn verify_owner_only_path_security(
		_: &Path,
		_: &str,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	pub(super) fn verify_owner_only_path_security_expected(
		_: &Path,
		_: &str,
		_: u64,
		_: u64,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}

	pub(super) fn repair_owner_only_path_security_expected(
		_: &Path,
		_: &str,
		_: u64,
		_: u64,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	pub(super) fn apply_owner_only_fd_security(
		_: &Path,
		_: &str,
		_: i32,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	pub(super) fn verify_owner_only_fd_security(
		_: &Path,
		_: &str,
		_: i32,
	) -> NativeOwnerOnlySecurityResult {
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
}
#[cfg(all(test, windows))]
mod owner_only_security_tests {
	use std::{
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{
		NativeExactUnlinkResult, NativeNoReplaceResult, apply_owner_only_path_security,
		rename_no_replace_path, verify_owner_only_path_security,
	};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-owner-security-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			std::fs::create_dir(&path).expect("create owner-security temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn owner_only_security_round_trips_local_directory_and_file() {
		let dir = TempDir::new();
		let directory = dir.0.to_string_lossy().into_owned();
		let applied_directory =
			apply_owner_only_path_security(directory.clone(), "directory".to_owned());
		assert!(applied_directory.ok, "{:?}", applied_directory.code);
		let verified_directory = verify_owner_only_path_security(directory, "directory".to_owned());
		assert!(verified_directory.ok, "{:?}", verified_directory.code);

		let file = dir.0.join("probe.tmp");
		std::fs::write(&file, b"owner-only").expect("write owner-security probe");
		let file = file.to_string_lossy().into_owned();
		let applied_file = apply_owner_only_path_security(file.clone(), "file".to_owned());
		assert!(applied_file.ok, "{:?}", applied_file.code);
		let verified_file = verify_owner_only_path_security(file, "file".to_owned());
		assert!(verified_file.ok, "{:?}", verified_file.code);
	}
	#[test]
	fn owner_only_security_rejects_missing_wrong_kind_and_reparse_paths() {
		let dir = TempDir::new();

		let missing = dir.0.join("missing.tmp").to_string_lossy().into_owned();
		let missing_result = verify_owner_only_path_security(missing, "file".to_owned());
		assert!(!missing_result.ok);
		assert_eq!(missing_result.code.as_deref(), Some("not_found"));

		let file = dir.0.join("target.tmp");
		std::fs::write(&file, b"owner-only").expect("write owner-security target");
		let wrong_kind = verify_owner_only_path_security(
			file.to_string_lossy().into_owned(),
			"directory".to_owned(),
		);
		assert!(!wrong_kind.ok);

		let link = dir.0.join("target-link.tmp");
		std::os::windows::fs::symlink_file(&file, &link)
			.expect("create owner-security reparse point");
		let reparse =
			verify_owner_only_path_security(link.to_string_lossy().into_owned(), "file".to_owned());
		assert!(!reparse.ok);
		assert_eq!(reparse.code.as_deref(), Some("reparse_point"));
	}
	#[test]
	fn rename_no_replace_uses_retained_parent_authority() {
		let dir = TempDir::new();
		let source = dir.0.join("source.tmp");
		let destination = dir.0.join("d");
		std::fs::write(&source, b"source").expect("write rename source");

		let renamed = rename_no_replace_path(
			source.to_string_lossy().into_owned(),
			destination.to_string_lossy().into_owned(),
		);
		assert!(renamed.ok, "{:?}", renamed.code);
		assert_eq!(renamed.mutation_state, "committed");
		assert_eq!(renamed.durability_state, "not_attempted");
		assert_eq!(renamed.reason, "none");
		assert_eq!(renamed.diagnostic.schema_version, 1);

		assert_eq!(std::fs::read(&destination).expect("read renamed destination"), b"source");

		let collision_source = dir.0.join("collision-source.tmp");
		std::fs::write(&collision_source, b"collision").expect("write collision source");
		let collision = rename_no_replace_path(
			collision_source.to_string_lossy().into_owned(),
			destination.to_string_lossy().into_owned(),
		);
		assert!(!collision.ok);
		assert_eq!(collision.code.as_deref(), Some("quarantine_collision"));
		assert_eq!(collision.mutation_state, "not_committed");
		assert_eq!(collision.reason, "destination_exists");
		assert_eq!(collision.durability_state, "not_attempted");
		assert_eq!(
			std::fs::read(&collision_source).expect("read retained collision source"),
			b"collision"
		);
		assert_eq!(std::fs::read(&destination).expect("read retained destination"), b"source");
	}

	#[test]
	fn rename_no_replace_invalid_request_is_a_preflight_failure() {
		let result =
			NativeNoReplaceResult::from_exact(NativeExactUnlinkResult::failure("invalid_request"));
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("invalid_request"));
		assert_eq!(result.mutation_state, "not_committed");
		assert_eq!(result.durability_state, "not_attempted");
		assert_eq!(result.reason, "invalid_request");
		assert_eq!(result.phase, "preflight");
	}

	#[test]
	fn rename_no_replace_destination_identity_loss_is_terminal() {
		let result = NativeNoReplaceResult::from_exact(NativeExactUnlinkResult::failure(
			"destination_identity_changed",
		));
		assert!(!result.ok);
		assert_eq!(result.mutation_state, "committed");
		assert_eq!(result.durability_state, "not_provable");
		assert_eq!(result.reason, "identity_violation");
		assert_eq!(result.phase, "terminal_identity");
	}

	#[test]
	fn rename_no_replace_rejects_nul_request_before_syscall() {
		let result = rename_no_replace_path("source\0".to_owned(), "destination".to_owned());
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("invalid_request"));
		assert_eq!(result.reason, "invalid_request");
		assert_eq!(result.phase, "preflight");
	}
}

#[cfg(all(test, windows))]
mod secure_skill_write_windows_tests {
	use std::{
		fs,
		path::PathBuf,
		sync::{
			Mutex,
			atomic::{AtomicU64, Ordering},
			mpsc,
		},
		thread,
	};

	use super::{platform, secure_write_skill_file};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);
	static HOOK_LOCK: Mutex<()> = Mutex::new(());

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-secure-skill-write-win-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir(&path).expect("create secure skill-write Windows temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn late_hard_link_swap_replaces_only_the_final_name() {
		let _guard = HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		fs::create_dir_all(&skill).expect("create skill directory");
		let final_path = skill.join("SKILL.md");
		let outside = temporary.0.join("outside.md");
		fs::write(&final_path, "before").expect("seed final file");
		fs::write(&outside, "outside").expect("seed external file");

		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_before_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"after".to_owned(),
				0o600,
			)
		});
		entered_rx.recv().expect("wait for private-file write");
		fs::remove_file(&final_path).expect("remove final name");
		fs::hard_link(&outside, &final_path).expect("install late hard-link alias");
		resume_tx.send(()).expect("release private-file write");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_before_rename_hook(None);

		assert!(result.ok, "{:?}", result.code);
		assert_eq!(fs::read_to_string(&outside).expect("read external file"), "outside");
		assert_eq!(fs::read_to_string(&final_path).expect("read published file"), "after");
	}

	#[test]
	fn post_rename_root_reachability_failure_is_reported_and_cleaned() {
		let _guard = HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		fs::create_dir_all(&skill).expect("create skill directory");

		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_after_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"detached-payload".to_owned(),
				0o600,
			)
		});
		entered_rx
			.recv()
			.expect("wait for committed private-file rename");

		let detached_root = temporary.0.join("detached-skills");
		fs::rename(&root, &detached_root).expect("detach published skills root");
		fs::create_dir(&root).expect("replace published skills root");
		resume_tx.send(()).expect("release post-rename validation");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_after_rename_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert!(!root.join("managed").join("SKILL.md").exists());
		assert!(!detached_root.join("managed").join("SKILL.md").exists());
	}

	#[test]
	fn private_file_denies_hard_link_creation_while_writable() {
		let _guard = HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		let outside = temporary.0.join("private-alias.md");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_before_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"private-stage".to_owned(),
				0o600,
			)
		});
		entered_rx.recv().expect("wait for private-file write");
		let private = fs::read_dir(&skill)
			.expect("read skill directory")
			.map(|entry| entry.expect("read private entry").path())
			.find(|path| {
				path
					.file_name()
					.is_some_and(|name| name.to_string_lossy().starts_with(".gjc-skill-write-"))
			})
			.expect("private skill file");
		assert!(fs::hard_link(&private, &outside).is_err());
		resume_tx.send(()).expect("release private-file write");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_before_rename_hook(None);

		assert!(result.ok, "{:?}", result.code);
		assert!(!outside.exists());
		assert_eq!(
			fs::read_to_string(skill.join("SKILL.md")).expect("read published file"),
			"private-stage"
		);
	}

	#[test]
	fn cleanup_failure_is_reported_after_private_payload_scrub() {
		let _guard = HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_before_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"private-stage".to_owned(),
				0o600,
			)
		});
		entered_rx.recv().expect("wait for private-file write");
		let private = fs::read_dir(&skill)
			.expect("read skill directory")
			.map(|entry| entry.expect("read private entry").path())
			.find(|path| {
				path
					.file_name()
					.is_some_and(|name| name.to_string_lossy().starts_with(".gjc-skill-write-"))
			})
			.expect("private skill file");
		fs::create_dir(skill.join("SKILL.md")).expect("block final replacement with a directory");
		platform::inject_secure_skill_cleanup_failure(true);
		resume_tx.send(()).expect("release private-file write");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_before_rename_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_failed"));
		assert_eq!(fs::read(&private).expect("read retained scrubbed private file"), b"");
	}

	#[test]
	fn concurrent_writers_publish_complete_payloads() {
		let _guard = HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let payloads: Vec<String> = (0..8)
			.map(|index| format!("payload-{index}-{}", "x".repeat(32 * 1024)))
			.collect();
		let workers: Vec<_> = payloads
			.iter()
			.cloned()
			.map(|content| {
				let root = root.clone();
				thread::spawn(move || {
					secure_write_skill_file(
						root.to_string_lossy().into_owned(),
						"managed".to_owned(),
						content,
						0o600,
					)
				})
			})
			.collect();
		for worker in workers {
			let result = worker.join().expect("secure skill writer worker");
			assert!(result.ok, "{:?}", result.code);
		}
		let final_contents = fs::read_to_string(root.join("managed").join("SKILL.md"))
			.expect("read concurrent final file");
		assert!(payloads.iter().any(|payload| payload == &final_contents));
	}
}

#[cfg(all(test, unix))]
mod retained_broker_publication_tests {
	use std::{
		ffi::CString,
		os::unix::ffi::OsStrExt,
		path::PathBuf,
		sync::{
			atomic::{AtomicU64, Ordering},
			mpsc,
		},
		time::Duration,
	};

	use super::{NativeRetainedBrokerPublication, publication::RetainedPublication};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-retained-broker-publication-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			std::fs::create_dir(&path).expect("create retained publication temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	fn publish(root: &PathBuf) {
		let sdk = root.join("sdk");
		let lock = sdk.join("broker.lock");
		std::fs::create_dir_all(&lock).expect("create broker lock");
		std::fs::write(lock.join("owner.json"), b"owner").expect("write owner record");
		std::fs::write(sdk.join("broker.json"), b"{\"heartbeatAt\":1234567890123}\n")
			.expect("write discovery record");
	}

	#[test]
	fn retained_publication_observes_writes_syncs_and_closes_without_reopening_paths() {
		let dir = TempDir::new();
		publish(&dir.0);
		let publication = RetainedPublication::open(&dir.0).expect("retain published objects");

		assert_eq!(publication.observe(), "owned");
		assert_eq!(publication.heartbeat("1234567890999"), "written");
		assert_eq!(publication.sync(), "synced");
		assert_eq!(
			std::fs::read_to_string(dir.0.join("sdk/broker.json")).expect("read retained discovery"),
			"{\"heartbeatAt\":1234567890999}\n"
		);

		std::fs::remove_file(dir.0.join("sdk/broker.json")).expect("remove published discovery");
		assert_eq!(publication.observe(), "absent");
		assert_eq!(publication.heartbeat("1234567890888"), "written");
		assert!(!dir.0.join("sdk/broker.json").exists());

		let retained = NativeRetainedBrokerPublication::retain(publication);
		assert_eq!(retained.close().kind, "closed");
		assert_eq!(retained.heartbeat_blocking("1234567890777"), "closed");
		assert_eq!(retained.sync_blocking(), "closed");
		assert_eq!(retained.observe().kind, "ambiguous");
	}

	#[test]
	fn retained_publication_reports_replacement_and_rejects_invalid_heartbeat_width() {
		let dir = TempDir::new();
		publish(&dir.0);
		let publication = RetainedPublication::open(&dir.0).expect("retain published objects");
		std::fs::rename(dir.0.join("sdk/broker.lock"), dir.0.join("sdk/replaced-lock"))
			.expect("replace lock namespace");
		std::fs::create_dir(dir.0.join("sdk/broker.lock")).expect("create replacement lock");

		assert_eq!(publication.observe(), "replaced");
		assert_eq!(publication.heartbeat("not-a-timestamp"), "ambiguous");
	}

	#[test]
	fn retained_publication_does_not_block_on_an_owner_fifo() {
		let dir = TempDir::new();
		publish(&dir.0);
		let owner = dir.0.join("sdk/broker.lock/owner.json");
		std::fs::remove_file(&owner).expect("remove regular owner record");
		let owner_name = CString::new(owner.as_os_str().as_bytes()).expect("owner path has no NUL");
		assert_eq!(unsafe { libc::mkfifo(owner_name.as_ptr(), 0o600) }, 0, "create owner FIFO");

		let (sender, receiver) = mpsc::channel();
		let root = dir.0.clone();
		let worker =
			std::thread::spawn(move || sender.send(RetainedPublication::open(&root).is_err()));
		assert!(
			receiver
				.recv_timeout(Duration::from_secs(2))
				.expect("owner FIFO must not block")
		);
		worker
			.join()
			.expect("retained publication probe thread must not panic")
			.expect("retained publication result must be delivered");
	}

	/// The shutdown contract under an unresolved blocking worker (#4704).
	///
	/// A real stalled `pwrite`/`fsync` cannot be produced on demand, but what it
	/// does to this type is exact and reproducible: it occupies the
	/// single-writer lock for an unbounded time. A thread parked while holding
	/// that lock is therefore a faithful stand-in, and it is the state the JS
	/// thread used to deadlock against -- `close()` and `observe()` took the
	/// same mutex.
	#[test]
	fn close_and_observe_never_wait_on_an_unresolved_blocking_worker() {
		let dir = TempDir::new();
		publish(&dir.0);
		let publication = RetainedPublication::open(&dir.0).expect("retain published objects");
		let retained = std::sync::Arc::new(NativeRetainedBrokerPublication::retain(publication));
		let (entered_tx, entered_rx) = std::sync::mpsc::channel();
		let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
		let worker_handle = std::sync::Arc::clone(&retained);
		let worker = std::thread::spawn(move || {
			let handle = worker_handle.acquire().expect("retained handle");
			handle.write_serialized(|_| {
				entered_tx.send(()).expect("report worker entry");
				release_rx.recv().expect("await worker release");
				"written".to_owned()
			})
		});
		entered_rx
			.recv_timeout(std::time::Duration::from_secs(10))
			.expect("worker must hold the single-writer lock");

		// Both run on the JS thread in production and must return regardless of the
		// parked worker. A regression here hangs the test rather than failing it,
		// which is the honest signal: that is what it does to the broker.
		assert_eq!(retained.observe().kind, "owned");
		assert_eq!(retained.close().kind, "closed");
		assert_eq!(retained.observe().kind, "ambiguous");

		// Authority is given up immediately, so work queued behind the parked worker
		// is refused instead of committing against abandoned authority.
		let queued = {
			let queued_handle = std::sync::Arc::clone(&retained);
			std::thread::spawn(move || queued_handle.heartbeat_blocking("1234567890111"))
		};

		release_tx.send(()).expect("release the parked worker");
		// The in-flight worker still completes and propagates its own result: close
		// detaches, it does not cancel or poison what was already committed.
		assert_eq!(worker.join().expect("worker thread"), "written");
		assert_eq!(queued.join().expect("queued thread"), "closed");
		assert_eq!(retained.heartbeat_blocking("1234567890222"), "closed");
		assert_eq!(retained.sync_blocking(), "closed");
	}
}

/// Regression coverage for a large legacy-session migration crashing with
/// `durability_failed`: a signal landing mid-syscall on the no-replace rename
/// primitive (used to publish every migrated artifact file) used to surface
/// as a single unretried EINTR, which the JS layer's exhaustive reason match
/// falls back to classifying as a fatal, unrecoverable durability failure —
/// even though nothing was ever mutated. Migrating thousands of artifacts
/// performs thousands of these renames, making a stray signal increasingly
/// likely to hit over the course of one migration. The fix restarts the
/// syscall on EINTR (bounded, since nothing committed) instead of failing.
#[cfg(all(test, unix))]
mod rename_no_replace_eintr_tests {
	use std::{
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{platform, rename_no_replace_path};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-rename-no-replace-eintr-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			std::fs::create_dir(&path).expect("create eintr temp directory");
			// macOS's default temp root (/var/...) is itself a symlink to
			// /private/var/...; the no-replace rename primitive under test walks
			// every path component with O_NOFOLLOW and fails closed on any
			// symlink, so the canonical (fully resolved) path is required here.
			let resolved = std::fs::canonicalize(&path).expect("canonicalize eintr temp directory");
			Self(resolved)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn rename_no_replace_restarts_past_transient_eintr() {
		let dir = TempDir::new();
		let source = dir.0.join("source.tmp");
		let destination = dir.0.join("destination.tmp");
		std::fs::write(&source, b"payload").expect("write rename source");

		// Fewer injected EINTRs than the retry bound: the rename must still
		// commit, proving a stray signal no longer aborts the migration.
		platform::inject_rename_no_replace_eintr(3);
		let result = rename_no_replace_path(
			source.to_string_lossy().into_owned(),
			destination.to_string_lossy().into_owned(),
		);
		assert!(result.ok, "{:?} / {}", result.code, result.reason);
		assert_eq!(result.reason, "none");
		assert_eq!(std::fs::read(&destination).expect("read migrated destination"), b"payload");
	}

	#[test]
	fn rename_no_replace_still_fails_closed_once_eintr_exhausts_the_retry_bound() {
		let dir = TempDir::new();
		let source = dir.0.join("source.tmp");
		let destination = dir.0.join("destination.tmp");
		std::fs::write(&source, b"payload").expect("write rename source");

		// More injected EINTRs than the retry bound: the bound must still be
		// enforced so a genuine signal storm cannot hang the migration forever.
		platform::inject_rename_no_replace_eintr(64);
		let result = rename_no_replace_path(
			source.to_string_lossy().into_owned(),
			destination.to_string_lossy().into_owned(),
		);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("interrupted"));
		assert_eq!(result.reason, "interrupted");
		assert_eq!(result.mutation_state, "not_committed");
		// Nothing committed: the source is untouched and no destination exists.
		assert_eq!(std::fs::read(&source).expect("read retained source"), b"payload");
		assert!(!destination.exists());

		// Clear the injector so later tests in this process are unaffected.
		platform::inject_rename_no_replace_eintr(0);
	}
}

#[cfg(all(test, unix))]
static PATH_IDENTITY_HOOK_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

// These tests pause exact_unlink at internal exchange hooks and block on
// unbounded channel recvs; macOS renameatx_np(RENAME_SWAP) rejects the
// file<->directory placeholder swap, so the hook is never reached and the
// recv hangs the whole nextest run. The exchange protocol they verify is
// only reachable in production through the Linux managed-session path.
#[cfg(all(test, target_os = "linux"))]
mod exact_unlink_placeholder_tests {
	use std::{
		fs,
		os::unix::fs::MetadataExt,
		sync::{MutexGuard, mpsc},
		thread,
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::{
		ExactFileIdentity, NativeDirectoryTreeSnapshot, NativeExactUnlinkResult,
		PATH_IDENTITY_HOOK_TEST_LOCK, platform, sha256,
	};

	struct ExchangeHookTestGuard {
		_guard: MutexGuard<'static, ()>,
	}

	impl Drop for ExchangeHookTestGuard {
		fn drop(&mut self) {
			platform::set_after_exchange_hook(None);
			platform::set_before_exchange_hook(None);
			platform::set_after_placeholder_detach_hook(None);
			platform::set_after_tree_validation_hook(None);
			platform::set_before_tree_root_rename_hook(None);
			platform::set_after_tree_scrub_hook(None);
			platform::set_before_tree_child_rename_hook(None);
			platform::set_after_tree_file_link_check_hook(None);
		}
	}

	fn exchange_hook_test_guard() -> ExchangeHookTestGuard {
		ExchangeHookTestGuard {
			_guard: PATH_IDENTITY_HOOK_TEST_LOCK
				.lock()
				.unwrap_or_else(|poisoned| poisoned.into_inner()),
		}
	}

	#[test]
	fn regular_successor_replaces_same_kind_placeholder_and_is_preserved() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-placeholder-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("endpoint.json");
		let successor = root.join("successor.json");
		let stale = root.join(".quarantine");
		fs::write(&target, b"stale").expect("write stale target");
		fs::write(&successor, b"live successor").expect("write successor");
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      None,
			parent_ino:      None,
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       false,
			detach_only:     false,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256:          Some(sha256(b"stale")),
			allow_hard_link: false,
		};
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_exchange_hook(Some((entered_tx, resume_rx)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		entered_rx.recv().expect("wait for exchange");

		assert!(
			fs::metadata(&target)
				.expect("stat regular placeholder")
				.is_file()
		);
		fs::rename(&successor, &target).expect("regular successor replaces regular placeholder");
		resume_tx.send(()).expect("resume unlink");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_after_exchange_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_pending"));
		assert_eq!(result.detached_path.as_deref(), Some(stale.to_string_lossy().as_ref()));
		assert_eq!(result.payload_durable, Some(true));
		let retained_successor = result
			.retained_unknown_path
			.as_deref()
			.expect("successor retained at an explicit unknown path");
		assert!(!target.exists(), "unclassified successor must not be restored by pathname");
		assert_eq!(fs::read(retained_successor).expect("read retained successor"), b"live successor");
		assert!(
			fs::read(&stale)
				.expect("stale quarantine scrubbed")
				.is_empty()
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	fn preserves_same_kind_successor(target_is_directory: bool) {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-same-kind-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		let successor = root.join("successor");
		let stale = root.join(".quarantine");
		if target_is_directory {
			fs::create_dir(&target).expect("create target directory");
			fs::create_dir(&successor).expect("create successor directory");
		} else {
			fs::write(&target, b"stale").expect("write stale target");
			fs::write(&successor, b"successor").expect("write successor file");
		}
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      None,
			parent_ino:      None,
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       target_is_directory,
			detach_only:     false,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256:          (!target_is_directory).then(|| sha256(b"stale")),
			allow_hard_link: false,
		};
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_exchange_hook(Some((entered_tx, resume_rx)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		entered_rx.recv().expect("wait for exchange");
		let placeholder = fs::metadata(&target).expect("stat placeholder");
		assert_eq!(placeholder.is_dir(), target_is_directory);
		fs::rename(&successor, &target).expect("same-kind successor replaces placeholder");
		resume_tx.send(()).expect("resume unlink");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_after_exchange_hook(None);
		assert!(!result.ok);
		assert!(matches!(result.code.as_deref(), Some("cleanup_pending" | "identity_mismatch")));

		assert_eq!(result.detached_path.as_deref(), Some(stale.to_string_lossy().as_ref()));
		let retained_successor = result
			.retained_unknown_path
			.as_deref()
			.expect("successor retained at an explicit unknown path");
		assert!(!target.exists(), "unclassified successor must not be restored by pathname");
		assert_eq!(
			fs::metadata(retained_successor)
				.expect("stat retained successor")
				.is_dir(),
			target_is_directory
		);
		assert!(stale.exists(), "stale quarantine was not retained");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn regular_target_preserves_regular_successor_after_exchange() {
		preserves_same_kind_successor(false);
	}

	#[test]
	fn directory_target_preserves_directory_successor_after_exchange() {
		preserves_same_kind_successor(true);
	}

	fn mismatch_preserves_same_kind_successor_and_stale_recovery(target_is_directory: bool) {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-mismatch-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		let successor = root.join("successor");
		let stale = root.join(".quarantine");
		if target_is_directory {
			fs::create_dir(&target).expect("create target directory");
			fs::create_dir(&successor).expect("create successor directory");
		} else {
			fs::write(&target, b"stale").expect("write stale target");
			fs::write(&successor, b"successor").expect("write successor file");
		}
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      None,
			parent_ino:      None,
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       target_is_directory,
			detach_only:     false,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256:          (!target_is_directory).then(|| sha256(b"stale")),
			allow_hard_link: false,
		};
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_exchange_hook(Some((entered_tx, resume_rx)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		entered_rx.recv().expect("wait for exchange");
		if target_is_directory {
			fs::write(stale.join("mutation"), b"mutated").expect("mutate detached directory");
		} else {
			fs::write(&stale, b"mutated").expect("mutate detached file");
		}
		fs::rename(&successor, &target).expect("same-kind successor replaces placeholder");
		resume_tx.send(()).expect("resume unlink");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_after_exchange_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.detached_path.as_deref(), Some(stale.to_string_lossy().as_ref()));
		let retained_successor = result
			.retained_unknown_path
			.as_deref()
			.expect("successor retained at an explicit unknown path");
		assert!(!target.exists(), "unclassified successor must not be restored by pathname");
		assert_eq!(
			fs::metadata(retained_successor)
				.expect("stat retained successor")
				.is_dir(),
			target_is_directory
		);
		assert!(stale.exists(), "mutated stale object was not recoverable at its detached path");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn regular_target_mismatch_preserves_regular_successor_and_stale_recovery() {
		mismatch_preserves_same_kind_successor_and_stale_recovery(false);
	}

	#[test]
	fn directory_target_mismatch_preserves_directory_successor_and_stale_recovery() {
		mismatch_preserves_same_kind_successor_and_stale_recovery(true);
	}

	fn retained_same_kind_placeholder_preserves_successor_after_detach_hook(
		target_is_directory: bool,
	) {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-placeholder-detach-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		let successor = root.join("successor");
		let stale = root.join(".quarantine");
		if target_is_directory {
			fs::create_dir(&target).expect("create target directory");
			fs::create_dir(&successor).expect("create successor directory");
		} else {
			fs::write(&target, b"stale").expect("write stale target");
			fs::write(&successor, b"successor").expect("write successor file");
		}
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      None,
			parent_ino:      None,
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       target_is_directory,
			detach_only:     false,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256:          (!target_is_directory).then(|| sha256(b"stale")),
			allow_hard_link: false,
		};
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_placeholder_detach_hook(Some((entered_tx, resume_rx)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		entered_rx
			.recv()
			.expect("wait for verified placeholder detach");
		fs::rename(&successor, &target).expect("same-kind successor fills detached canonical name");
		resume_tx.send(()).expect("resume unlink");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_after_placeholder_detach_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_pending"));
		assert_eq!(result.detached_path.as_deref(), Some(stale.to_string_lossy().as_ref()));
		let retained = result
			.retained_placeholder_path
			.expect("retained placeholder path");
		assert_eq!(
			fs::metadata(&retained)
				.expect("stat retained placeholder")
				.is_dir(),
			target_is_directory
		);
		assert_eq!(fs::metadata(&target).expect("stat successor").is_dir(), target_is_directory);
		assert!(stale.exists(), "stale quarantine was not retained");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn regular_target_retains_regular_placeholder_after_detach_hook() {
		retained_same_kind_placeholder_preserves_successor_after_detach_hook(false);
	}

	#[test]
	fn directory_target_retains_directory_placeholder_after_detach_hook() {
		retained_same_kind_placeholder_preserves_successor_after_detach_hook(true);
	}

	fn poisoned_same_kind_successor_is_retained_without_overwriting_the_next_successor(
		detach_only: bool,
	) {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-retained-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		let first_successor = root.join("first-successor");
		let second_successor = root.join("second-successor");
		let stale = root.join(".quarantine");
		fs::write(&target, b"stale").expect("write stale target");
		fs::write(&first_successor, b"first").expect("write first successor");
		fs::write(&second_successor, b"second").expect("write second successor");
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev: metadata.dev(),
			ino: metadata.ino(),
			nlink: Some(metadata.nlink()),
			parent_dev: None,
			parent_ino: None,
			size: metadata.size(),
			mtime_ns: metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory: false,
			detach_only,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256: Some(sha256(b"stale")),
			allow_hard_link: false,
		};
		let (exchange_entered_tx, exchange_entered_rx) = mpsc::channel();
		let (exchange_resume_tx, exchange_resume_rx) = mpsc::channel();
		platform::set_after_exchange_hook(Some((exchange_entered_tx, exchange_resume_rx)));
		let (placeholder_entered_tx, placeholder_entered_rx) = mpsc::channel();
		let (placeholder_resume_tx, placeholder_resume_rx) = mpsc::channel();
		platform::set_after_placeholder_detach_hook(Some((
			placeholder_entered_tx,
			placeholder_resume_rx,
		)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		exchange_entered_rx.recv().expect("wait for exchange");
		fs::rename(&first_successor, &target).expect("first regular successor replaces placeholder");
		exchange_resume_tx.send(()).expect("resume exchange");
		placeholder_entered_rx
			.recv()
			.expect("wait for first successor detach");
		fs::rename(&second_successor, &target)
			.expect("second regular successor prevents restoration");
		placeholder_resume_tx
			.send(())
			.expect("resume placeholder cleanup");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_after_exchange_hook(None);
		platform::set_after_placeholder_detach_hook(None);

		assert!(!result.ok);
		assert_eq!(
			result.code.as_deref(),
			Some(if detach_only {
				"identity_mismatch"
			} else {
				"cleanup_pending"
			}),
		);
		assert_eq!(result.detached_path.as_deref(), Some(stale.to_string_lossy().as_ref()));
		assert_eq!(result.payload_durable, if detach_only { None } else { Some(true) });
		assert_eq!(fs::read(&target).expect("read second successor"), b"second");
		if detach_only {
			assert_eq!(fs::read(&stale).expect("read retained stale object"), b"stale");
		} else {
			assert!(
				fs::read(&stale)
					.expect("read scrubbed stale object")
					.is_empty()
			);
		}
		let retained = fs::read_dir(&root)
			.expect("read temporary directory")
			.map(|entry| entry.expect("read temporary entry").path())
			.find(|path| {
				path
					.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(|name| name.starts_with(".gjc-exact-unlink-placeholder-"))
			})
			.expect("find retained poisoned successor");
		assert_eq!(fs::read(retained).expect("read retained poisoned successor"), b"first");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn poisoned_successor_after_stale_removal_is_retained() {
		poisoned_same_kind_successor_is_retained_without_overwriting_the_next_successor(false);
	}

	#[test]
	fn poisoned_successor_and_stale_quarantine_are_retained() {
		poisoned_same_kind_successor_is_retained_without_overwriting_the_next_successor(true);
	}

	#[test]
	fn exchange_failure_retains_replaced_placeholder_at_detached_path() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-exact-unlink-exchange-failure-placeholder-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::write(&target, b"stale").expect("write stale target");
		let metadata = fs::metadata(&target).expect("stat target");
		let identity = ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      None,
			parent_ino:      None,
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       false,
			detach_only:     false,
			quarantine_name: Some(".quarantine".to_owned()),
			sha256:          Some(sha256(b"stale")),
			allow_hard_link: false,
		};
		let (exchange_entered_tx, exchange_entered_rx) = mpsc::channel();
		let (exchange_resume_tx, exchange_resume_rx) = mpsc::channel();
		platform::set_before_exchange_hook(Some((exchange_entered_tx, exchange_resume_rx)));
		let (placeholder_entered_tx, placeholder_entered_rx) = mpsc::channel();
		let (placeholder_resume_tx, placeholder_resume_rx) = mpsc::channel();
		platform::set_after_placeholder_detach_hook(Some((
			placeholder_entered_tx,
			placeholder_resume_rx,
		)));
		let target_for_unlink = target.clone();
		let unlink = thread::spawn(move || platform::exact_unlink(&target_for_unlink, &identity));
		exchange_entered_rx.recv().expect("wait before exchange");
		fs::remove_file(&target).expect("remove exchange source to force failure");
		exchange_resume_tx.send(()).expect("resume exchange");
		placeholder_entered_rx
			.recv()
			.expect("wait for placeholder cleanup detach");
		let retained = fs::read_dir(&root)
			.expect("read temporary directory")
			.map(|entry| entry.expect("read temporary entry").path())
			.find(|path| {
				path
					.file_name()
					.and_then(|name| name.to_str())
					.is_some_and(|name| name.starts_with(".gjc-exact-unlink-placeholder-"))
			})
			.expect("find detached placeholder");
		let replacement = root.join("replacement");
		fs::write(&replacement, b"unrelated").expect("write distinct replacement inode");
		fs::remove_file(&retained).expect("remove detached placeholder");
		fs::rename(&replacement, &retained).expect("replace detached placeholder");
		placeholder_resume_tx
			.send(())
			.expect("resume placeholder cleanup");
		let result = unlink.join().expect("exact unlink thread");
		platform::set_before_exchange_hook(None);
		platform::set_after_placeholder_detach_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_failed"));
		assert!(result.detached_path.is_none());
		assert!(result.retained_successor_path.is_none());
		assert!(result.retained_placeholder_path.is_none());
		assert_eq!(
			result.retained_unknown_path.as_deref(),
			Some(retained.to_string_lossy().as_ref())
		);
		assert!(
			!root.join(".quarantine").exists(),
			"unrelated detached object was republished at the canonical cleanup name"
		);
		assert_eq!(fs::read(&retained).expect("read retained unrelated object"), b"unrelated");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn retained_internal_placeholder_is_not_reported_as_a_successor() {
		let result = NativeExactUnlinkResult::retained_placeholder_failure(
			"io_error",
			"/tmp/.gjc-exact-unlink-placeholder-verified".to_owned(),
		);
		assert!(!result.ok);
		assert!(result.detached_path.is_none());
		assert!(result.retained_successor_path.is_none());
		assert_eq!(
			result.retained_placeholder_path.as_deref(),
			Some("/tmp/.gjc-exact-unlink-placeholder-verified")
		);
	}

	fn assert_tree_replay_result(result: &NativeExactUnlinkResult, detached: &std::path::Path) {
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_pending"));
		assert_eq!(result.detached_path.as_deref(), Some(detached.to_string_lossy().as_ref()));
		assert_eq!(result.payload_durable, Some(true));
		assert!(result.retained_successor_path.is_none());
		assert!(result.retained_placeholder_path.is_none());
		assert!(result.retained_unknown_path.is_none());
	}

	fn tree_is_descriptor_scrubbed(
		observed: &NativeDirectoryTreeSnapshot,
		expected: &NativeDirectoryTreeSnapshot,
	) -> bool {
		let mut observed_identities = observed
			.entries
			.iter()
			.map(|entry| (&entry.kind, &entry.dev, &entry.ino))
			.collect::<Vec<_>>();
		let mut expected_identities = expected
			.entries
			.iter()
			.map(|entry| (&entry.kind, &entry.dev, &entry.ino))
			.collect::<Vec<_>>();
		observed_identities.sort();
		expected_identities.sort();
		observed.root_dev == expected.root_dev
			&& observed.root_ino == expected.root_ino
			&& observed_identities == expected_identities
			&& observed.entries.iter().all(|entry| {
				(entry.relative_path.is_empty() && entry.kind == "directory")
					|| entry.kind == "directory"
					|| (entry.size == "0"
						&& entry.sha256.as_deref()
							== Some("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
			})
	}

	fn replay_retains_verified_tree(nested: bool) {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-replay-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		if nested {
			fs::create_dir_all(target.join("nested")).expect("create nested tree");
			fs::write(target.join("root-file"), b"root").expect("write root file");
			fs::write(target.join("nested/file"), b"nested").expect("write nested file");
		}
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let detached = std::path::PathBuf::from(format!("{}.removing", target.to_string_lossy()));

		let first = platform::exact_remove_directory_tree(&target, &snapshot, None);
		assert_tree_replay_result(&first, &detached);
		let first_snapshot = platform::snapshot_directory_tree(&detached)
			.snapshot
			.expect("snapshot detached");
		assert!(
			tree_is_descriptor_scrubbed(&first_snapshot, &snapshot),
			"first retained tree contains no authorized payload",
		);

		let second = platform::exact_remove_directory_tree(&target, &snapshot, None);
		assert_tree_replay_result(&second, &detached);
		let second_snapshot = platform::snapshot_directory_tree(&detached)
			.snapshot
			.expect("snapshot detached");
		assert_eq!(second_snapshot, first_snapshot, "replay does not mutate the scrubbed tree");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn empty_tree_retention_replays_on_second_call_with_exact_evidence() {
		replay_retains_verified_tree(false);
	}

	#[test]
	fn nested_tree_retention_replays_on_second_call_with_exact_evidence() {
		replay_retains_verified_tree(true);
	}

	#[test]
	fn root_parent_fsync_failures_withhold_durable_marker_and_replay() {
		let _guard = exchange_hook_test_guard();
		for fail_on_call in [1, 2] {
			let root = std::env::temp_dir().join(format!(
				"gjc-tree-root-fsync-{fail_on_call}-{}-{}",
				std::process::id(),
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.expect("system time")
					.as_nanos(),
			));
			fs::create_dir(&root).expect("create temporary directory");
			let target = root.join("target");
			fs::create_dir(&target).expect("create target");
			fs::write(target.join("payload.bin"), b"authorized payload").expect("write payload");
			let snapshot = platform::snapshot_directory_tree(&target)
				.snapshot
				.expect("snapshot target");
			let detached = std::path::PathBuf::from(format!("{}.removing", target.to_string_lossy()));

			platform::inject_root_parent_fsync_failure(fail_on_call);
			let interrupted = platform::exact_remove_directory_tree(&target, &snapshot, None);
			assert!(!interrupted.ok);
			assert_eq!(interrupted.code.as_deref(), Some("io_error"));
			assert_eq!(
				interrupted.detached_path.as_deref(),
				Some(detached.to_string_lossy().as_ref())
			);
			assert_eq!(interrupted.payload_durable, None);

			platform::inject_root_parent_fsync_failure(0);
			let replayed = platform::exact_remove_directory_tree(&target, &snapshot, None);
			assert_tree_replay_result(&replayed, &detached);
			let replayed_snapshot = platform::snapshot_directory_tree(&detached)
				.snapshot
				.expect("snapshot replayed tree");
			assert!(tree_is_descriptor_scrubbed(&replayed_snapshot, &snapshot));
			fs::remove_dir_all(root).expect("remove temporary directory");
		}
	}

	#[test]
	fn tree_scrub_preserves_a_substituted_root_successor_after_validation() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("state.json"), b"authorized stale payload")
			.expect("write stale payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let detached = target.clone();
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_before_tree_root_rename_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx.recv().expect("wait for root validation");
		let retained_stale = root.join("retained-stale-root");
		fs::rename(&target, &retained_stale).expect("retain stale root");
		fs::create_dir(&target).expect("publish successor root");
		fs::write(target.join("state.json"), b"substituted successor")
			.expect("write successor payload");
		resume_tx.send(()).expect("resume tree scrub");
		let result = removal.join().expect("tree scrub thread");
		platform::set_before_tree_root_rename_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert!(result.detached_path.is_none());
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(detached.to_string_lossy().as_ref())
		);
		assert_eq!(
			fs::read(detached.join("state.json")).expect("read successor"),
			b"substituted successor"
		);
		assert_eq!(
			fs::read(retained_stale.join("state.json")).expect("read stale object"),
			b"authorized stale payload"
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_scrub_restores_a_regular_file_root_successor() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-file-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("state.json"), b"authorized stale payload")
			.expect("write stale payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_before_tree_root_rename_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx.recv().expect("wait for root validation");
		let retained_stale = root.join("retained-stale-root");
		fs::rename(&target, &retained_stale).expect("retain stale root");
		fs::write(&target, b"regular-file successor").expect("publish file successor");
		resume_tx.send(()).expect("resume tree scrub");
		let result = removal.join().expect("tree scrub thread");
		platform::set_before_tree_root_rename_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(target.to_string_lossy().as_ref())
		);
		assert_eq!(fs::read(&target).expect("read successor"), b"regular-file successor");
		assert_eq!(
			fs::read(retained_stale.join("state.json")).expect("read stale object"),
			b"authorized stale payload"
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_scrub_rejects_a_post_scrub_retained_root_successor() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-post-scrub-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		let detached = std::path::PathBuf::from(format!("{}.removing", target.to_string_lossy()));
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("state.json"), b"authorized stale payload")
			.expect("write stale payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_tree_scrub_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx
			.recv()
			.expect("wait for post-scrub receipt boundary");
		let retained_scrubbed = root.join("retained-scrubbed-root");
		fs::rename(&detached, &retained_scrubbed).expect("retain scrubbed root");
		fs::create_dir(&detached).expect("publish retained-name successor");
		fs::write(detached.join("state.json"), b"successor payload")
			.expect("write successor payload");
		resume_tx.send(()).expect("resume durable receipt");
		let result = removal.join().expect("tree scrub thread");
		platform::set_after_tree_scrub_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.payload_durable, None);
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(detached.to_string_lossy().as_ref())
		);
		assert_eq!(
			fs::read(detached.join("state.json")).expect("read successor"),
			b"successor payload"
		);
		assert_eq!(
			fs::read(retained_scrubbed.join("state.json")).expect("read scrubbed original"),
			b""
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_scrub_rejects_external_hard_links_without_truncation() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-hard-link-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");

		let rejected = root.join("rejected");
		fs::create_dir(&rejected).expect("create rejected tree");
		fs::write(rejected.join("payload.bin"), b"shared payload").expect("write rejected payload");
		fs::hard_link(rejected.join("payload.bin"), root.join("rejected-alias.bin"))
			.expect("link rejected alias");
		let rejected_snapshot = platform::snapshot_directory_tree(&rejected);
		assert!(!rejected_snapshot.ok);
		assert_eq!(rejected_snapshot.code.as_deref(), Some("hard_link_unsupported"));
		assert_eq!(
			fs::read(root.join("rejected-alias.bin")).expect("read rejected alias"),
			b"shared payload"
		);

		let raced = root.join("raced");
		fs::create_dir(&raced).expect("create raced tree");
		fs::write(raced.join("payload.bin"), b"raced shared payload").expect("write raced payload");
		let raced_snapshot = platform::snapshot_directory_tree(&raced)
			.snapshot
			.expect("snapshot unlinked tree");
		let alias = root.join("raced-alias.bin");
		fs::hard_link(raced.join("payload.bin"), &alias).expect("link raced alias");
		let result = platform::exact_remove_directory_tree(&raced, &raced_snapshot, None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("hard_link_unsupported"));
		assert_eq!(result.payload_durable, None);
		let detached = std::path::PathBuf::from(
			result
				.detached_path
				.as_deref()
				.expect("retained detached root"),
		);
		assert_eq!(
			fs::read(detached.join("payload.bin")).expect("read retained payload"),
			b"raced shared payload"
		);
		assert_eq!(fs::read(alias).expect("read external alias"), b"raced shared payload");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_scrub_rechecks_hard_links_at_truncate_boundary() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-late-hard-link-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("payload.bin"), b"late shared payload").expect("write payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_tree_file_link_check_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx
			.recv()
			.expect("wait for final hard-link check boundary");
		let detached = fs::read_dir(&root)
			.expect("list root")
			.map(|entry| entry.expect("read entry").path())
			.find(|entry| entry.is_dir() && entry.join("payload.bin").exists())
			.expect("find detached root");
		let alias = root.join("late-alias.bin");
		fs::hard_link(detached.join("payload.bin"), &alias).expect("link late alias");
		resume_tx.send(()).expect("resume final hard-link check");
		let result = removal.join().expect("tree scrub thread");
		platform::set_after_tree_file_link_check_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("hard_link_unsupported"));
		assert_eq!(result.payload_durable, None);
		assert_eq!(fs::read(&alias).expect("read external alias"), b"late shared payload");
		let retained = detached.join("payload.bin");
		assert_eq!(fs::read(retained).expect("read retained artifact"), b"late shared payload");
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_scrub_rechecks_payload_digest_at_truncate_boundary() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-late-payload-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("payload.bin"), b"authorized payload").expect("write payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_tree_file_link_check_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx
			.recv()
			.expect("wait for final payload check boundary");
		let detached = fs::read_dir(&root)
			.expect("list root")
			.map(|entry| entry.expect("read entry").path())
			.find(|entry| entry.is_dir() && entry.join("payload.bin").exists())
			.expect("find detached root");
		fs::write(detached.join("payload.bin"), b"substituted payload")
			.expect("replace payload bytes");
		resume_tx.send(()).expect("resume final payload check");
		let result = removal.join().expect("tree scrub thread");
		platform::set_after_tree_file_link_check_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(
			fs::read(detached.join("payload.bin")).expect("read retained artifact"),
			b"substituted payload"
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}

	#[test]
	fn tree_child_revalidation_preserves_same_name_successor() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-child-successor-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		fs::write(target.join("state.json"), b"authorized stale payload")
			.expect("write stale payload");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let detached = std::path::PathBuf::from(format!("{}.removing", target.to_string_lossy()));
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_before_tree_child_rename_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx.recv().expect("wait for child rename boundary");
		let retained_stale = detached.join("retained-stale");
		fs::rename(detached.join("state.json"), &retained_stale).expect("retain authorized object");
		fs::write(detached.join("state.json"), b"same-name successor").expect("publish successor");
		let successor_identity = fs::metadata(detached.join("state.json")).expect("stat successor");
		resume_tx.send(()).expect("resume child rename");
		let result = removal.join().expect("tree scrub thread");
		platform::set_before_tree_child_rename_hook(None);
		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.payload_durable, None);
		assert_eq!(
			fs::read(detached.join("state.json")).expect("read successor"),
			b"same-name successor"
		);
		let restored_identity =
			fs::metadata(detached.join("state.json")).expect("stat restored successor");
		assert_eq!(restored_identity.dev(), successor_identity.dev());
		assert_eq!(restored_identity.ino(), successor_identity.ino());
		assert_eq!(
			fs::read(retained_stale).expect("read authorized object"),
			b"authorized stale payload"
		);
		assert!(
			fs::read_dir(&detached)
				.expect("list detached root")
				.all(|entry| !entry
					.expect("read entry")
					.file_name()
					.to_string_lossy()
					.starts_with(".pi-tree-detached-"))
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}
	#[test]
	fn aborted_tree_hook_does_not_block_the_next_hook() {
		let _guard = exchange_hook_test_guard();
		let root = std::env::temp_dir().join(format!(
			"gjc-tree-hook-abort-{}-{}",
			std::process::id(),
			SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time")
				.as_nanos(),
		));
		fs::create_dir(&root).expect("create temporary directory");
		let target = root.join("target");
		fs::create_dir(&target).expect("create target");
		let snapshot = platform::snapshot_directory_tree(&target)
			.snapshot
			.expect("snapshot target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		drop(resume_tx);
		platform::set_after_tree_validation_hook(Some((entered_tx, resume_rx)));
		let target_for_remove = target.clone();
		let aborted = thread::spawn(move || {
			platform::exact_remove_directory_tree(&target_for_remove, &snapshot, None)
		});
		entered_rx.recv().expect("wait for aborted hook");
		assert!(aborted.join().is_err(), "disconnected hook did not abort");

		let next = root.join("next");
		fs::create_dir(&next).expect("create next target");
		let snapshot = platform::snapshot_directory_tree(&next)
			.snapshot
			.expect("snapshot next target");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_after_tree_validation_hook(Some((entered_tx, resume_rx)));
		let next_for_remove = next.clone();
		let removal = thread::spawn(move || {
			platform::exact_remove_directory_tree(&next_for_remove, &snapshot, None)
		});
		entered_rx.recv().expect("wait for next hook");
		resume_tx.send(()).expect("resume next hook");
		assert_eq!(
			removal.join().expect("next removal thread").code.as_deref(),
			Some("cleanup_pending"),
		);
		fs::remove_dir_all(root).expect("remove temporary directory");
	}
}
/// The `linkat` stand-in for `renameat2(RENAME_NOREPLACE)` used on filesystems
/// that implement no rename flag at all. These run on any POSIX filesystem: the
/// point is that the fallback's no-overwrite guarantee and its refusal to touch
/// a directory hold everywhere, not only on the NFS mount that needs it.
#[cfg(all(test, unix))]
mod link_no_replace_tests {
	use std::{
		fs,
		os::unix::fs::MetadataExt,
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
		thread,
	};

	use super::{link_no_replace_path, rename_directory_no_replace_path, rename_no_replace_path};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-link-no-replace-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir(&path).expect("create link no-replace temp directory");
			Self(path)
		}

		fn join(&self, name: &str) -> String {
			self.0.join(name).to_string_lossy().into_owned()
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// The staging name deliberately survives publication. That asymmetry with
	/// `renameat2` is what lets a caller holding a descriptor on the staged
	/// object keep it across publication and unlink the staging name only after
	/// releasing it — the ordering NFS silly-renaming makes mandatory.
	#[test]
	fn link_no_replace_publishes_the_destination_and_keeps_the_staging_name() {
		let temporary = TempDir::new();
		fs::write(temporary.0.join("staging"), b"payload").expect("seed staging");

		let published = link_no_replace_path(temporary.join("staging"), temporary.join("published"));

		assert!(published.ok, "publish must commit: {:?}", published.code);
		assert_eq!(published.reason, "none");
		assert_eq!(published.mutation_state, "committed");
		assert_eq!(
			fs::read(temporary.0.join("published")).expect("read published"),
			b"payload",
			"the destination must carry the staged bytes"
		);
		let staged = fs::metadata(temporary.0.join("staging")).expect("staging survives publication");
		let destination = fs::metadata(temporary.0.join("published")).expect("stat published");
		assert_eq!(
			(staged.dev(), staged.ino()),
			(destination.dev(), destination.ino()),
			"the destination must be a link to the staged inode, not a copy"
		);
	}

	/// The guarantee the fallback exists to preserve: `linkat` reports `EEXIST`
	/// exactly where `renameat2(RENAME_NOREPLACE)` reports it, so standing in
	/// for the missing primitive never authorizes an overwrite.
	#[test]
	fn link_no_replace_refuses_an_occupied_destination_exactly_as_rename_does() {
		let temporary = TempDir::new();
		fs::write(temporary.0.join("staging"), b"payload").expect("seed staging");
		fs::write(temporary.0.join("occupied"), b"existing").expect("seed destination");

		let linked = link_no_replace_path(temporary.join("staging"), temporary.join("occupied"));
		let renamed = rename_no_replace_path(temporary.join("staging"), temporary.join("occupied"));

		assert!(!linked.ok, "an occupied destination must never be published over");
		assert_eq!(linked.reason, "destination_exists");
		assert_eq!(linked.mutation_state, "not_committed");
		assert_eq!(
			linked.reason, renamed.reason,
			"the fallback must classify an occupied destination exactly as the primitive it replaces"
		);
		assert_eq!(
			fs::read(temporary.0.join("occupied")).expect("read destination"),
			b"existing",
			"the occupying file must be left untouched"
		);
	}

	/// `linkat` cannot hard-link a directory. Rejecting one before the syscall
	/// keeps a directory publish from silently degrading into a partial one.
	#[test]
	fn link_no_replace_refuses_a_directory_source() {
		let temporary = TempDir::new();
		fs::create_dir(temporary.0.join("tree")).expect("seed directory source");

		let linked = link_no_replace_path(temporary.join("tree"), temporary.join("published"));

		assert!(!linked.ok, "a directory source must never be published through linkat");
		assert_eq!(linked.reason, "identity_violation");
		assert_eq!(linked.mutation_state, "not_committed");
		assert!(
			!temporary.0.join("published").exists(),
			"a rejected directory publish must leave no destination behind"
		);
	}

	#[test]
	fn directory_fallback_publishes_descriptor_relative_without_overwriting() {
		let temporary = TempDir::new();
		fs::create_dir(temporary.0.join("staging")).expect("seed staging directory");
		fs::write(temporary.0.join("staging/info"), b"owner").expect("seed owner record");

		let published =
			rename_directory_no_replace_path(temporary.join("staging"), temporary.join("published"));

		assert!(published.ok, "directory fallback must publish: {:?}", published.code);
		assert_eq!(published.primitive, "mkdirat_renameat_noreplace");
		assert_eq!(
			fs::read(temporary.0.join("published/info")).expect("read owner record"),
			b"owner"
		);
		assert!(!temporary.0.join("staging").exists(), "staging name must be consumed");

		fs::create_dir(temporary.0.join("staging-again")).expect("seed collision staging");
		fs::write(temporary.0.join("staging-again/info"), b"successor")
			.expect("seed successor record");
		let collision = rename_directory_no_replace_path(
			temporary.join("staging-again"),
			temporary.join("published"),
		);
		assert!(!collision.ok, "an occupied destination must not be replaced");
		assert_eq!(collision.reason, "destination_exists");
		assert_eq!(
			fs::read(temporary.0.join("published/info")).expect("read original owner"),
			b"owner"
		);
	}

	#[test]
	fn directory_fallback_rejects_symlinked_staging_without_following_it() {
		let temporary = TempDir::new();
		fs::create_dir(temporary.0.join("outside")).expect("seed outside directory");
		fs::write(temporary.0.join("outside/info"), b"outside").expect("seed outside owner");
		std::os::unix::fs::symlink(temporary.0.join("outside"), temporary.0.join("staging"))
			.expect("seed staging symlink");

		let rejected =
			rename_directory_no_replace_path(temporary.join("staging"), temporary.join("published"));

		assert!(!rejected.ok, "a symlinked staging path must be rejected");
		assert_eq!(rejected.reason, "identity_violation");
		assert!(
			!temporary.0.join("published").exists(),
			"rejected publish must not create a destination"
		);
		assert!(temporary.0.join("outside").exists(), "outside target must remain untouched");
	}

	#[test]
	fn directory_fallback_allows_only_one_concurrent_contender_to_claim_the_name() {
		let temporary = TempDir::new();
		for name in ["staging-a", "staging-b"] {
			fs::create_dir(temporary.0.join(name)).expect("seed contender directory");
			fs::write(temporary.0.join(name).join("info"), name.as_bytes())
				.expect("seed contender owner");
		}
		let destination = temporary.join("published");
		let left_source = temporary.join("staging-a");
		let right_source = temporary.join("staging-b");
		let left_destination = destination.clone();
		let left =
			thread::spawn(move || rename_directory_no_replace_path(left_source, left_destination));
		let right =
			thread::spawn(move || rename_directory_no_replace_path(right_source, destination));
		let outcomes = [left.join().expect("left contender"), right.join().expect("right contender")];

		assert_eq!(outcomes.iter().filter(|result| result.ok).count(), 1);
		assert_eq!(
			outcomes
				.iter()
				.filter(|result| result.reason == "destination_exists")
				.count(),
			1
		);
		let winner = fs::read(temporary.0.join("published/info")).expect("winner owner record");
		assert!(winner == b"staging-a" || winner == b"staging-b");
	}
}

#[cfg(all(test, unix))]
mod exact_replace_path_tests {
	use std::{
		fs,
		os::unix::fs::MetadataExt,
		path::{Path, PathBuf},
		sync::{
			atomic::{AtomicU64, Ordering},
			mpsc,
		},
		thread,
	};

	use super::{
		ExactFileIdentity, PATH_IDENTITY_HOOK_TEST_LOCK as EXACT_REPLACE_HOOK_LOCK, platform, sha256,
	};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-exact-replace-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir(&path).expect("create exact replace temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn identity(path: &Path, parent: &Path, bytes: &[u8]) -> ExactFileIdentity {
		let metadata = fs::metadata(path).expect("stat exact replace file");
		let parent = fs::metadata(parent).expect("stat exact replace parent");
		ExactFileIdentity {
			dev:             metadata.dev(),
			ino:             metadata.ino(),
			nlink:           Some(metadata.nlink()),
			parent_dev:      Some(parent.dev()),
			parent_ino:      Some(parent.ino()),
			size:            metadata.size(),
			mtime_ns:        metadata.mtime_nsec() + metadata.mtime() * 1_000_000_000,
			directory:       false,
			detach_only:     false,
			quarantine_name: None,
			sha256:          Some(sha256(bytes)),
			allow_hard_link: false,
		}
	}

	#[test]
	fn exact_replace_path_commits_and_scrubs_the_predecessor() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");

		let result = platform::exact_replace_path(
			&source,
			&destination,
			&expected_source,
			&expected_destination,
		);

		assert!(result.ok, "exact replacement failed: {:?}", result.code);
		assert_eq!(fs::read(&destination).expect("read committed successor"), b"successor");
		assert!(!source.exists(), "the random staging name must not survive replacement");
		let retained = fs::read_dir(&temporary.0)
			.expect("read replacement directory")
			.filter_map(Result::ok)
			.map(|entry| entry.path())
			.filter(|path| path != &destination)
			.collect::<Vec<_>>();
		assert_eq!(retained.len(), 3, "only scrubbed internal placeholders may remain");
		for path in retained {
			assert_eq!(fs::read(path).expect("read scrubbed placeholder"), b"");
		}
	}

	#[test]
	fn exact_replace_path_refuses_a_substituted_destination() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		let authorized = temporary.0.join("authorized-predecessor");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		fs::rename(&destination, &authorized).expect("retain authorized predecessor");
		fs::write(&destination, b"substituted").expect("publish substituted destination");

		let result = platform::exact_replace_path(
			&source,
			&destination,
			&expected_source,
			&expected_destination,
		);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(fs::read(&destination).expect("read substituted destination"), b"substituted");
		assert_eq!(fs::read(&source).expect("read untouched successor"), b"successor");
		assert_eq!(fs::read(&authorized).expect("read authorized predecessor"), b"predecessor");
	}

	#[test]
	fn exact_replace_path_reports_both_mutated_names_after_pre_exchange_substitution() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		let retained_source = temporary.0.join("authorized-successor");
		let retained_destination = temporary.0.join("authorized-predecessor");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_before_exchange_hook(Some((entered_tx, resume_rx)));
		let source_for_replace = source.clone();
		let destination_for_replace = destination.clone();
		let replace = thread::spawn(move || {
			platform::exact_replace_path(
				&source_for_replace,
				&destination_for_replace,
				&expected_source,
				&expected_destination,
			)
		});
		entered_rx
			.recv()
			.expect("wait for exact replacement pre-exchange hook");
		fs::rename(&source, &retained_source).expect("retain authorized successor");
		fs::write(&source, b"attacker-source").expect("substitute source");
		fs::rename(&destination, &retained_destination).expect("retain authorized predecessor");
		fs::write(&destination, b"attacker-destination").expect("substitute destination");
		resume_tx.send(()).expect("resume exact replacement");
		let result = replace.join().expect("exact replacement thread");
		platform::set_before_exchange_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		let detached = result
			.detached_path
			.as_deref()
			.expect("retained private predecessor path");
		assert!(detached.contains(".gjc-exact-replace-source-"));
		assert_eq!(
			result.retained_unknown_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(fs::read(&destination).expect("read committed destination"), b"successor");
		assert_eq!(fs::read(&source).expect("read substituted source"), b"attacker-source");
		assert_eq!(
			fs::read(detached).expect("read retained private predecessor"),
			b"attacker-destination"
		);
		assert_eq!(fs::read(&retained_source).expect("read retained successor"), b"successor");
		assert_eq!(
			fs::read(&retained_destination).expect("read retained predecessor"),
			b"predecessor"
		);
	}
	#[test]
	fn exact_replace_path_preserves_substituted_source_after_exchange() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		let predecessor = temporary.0.join("authorized-predecessor");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_exact_replace_after_exchange_hook(Some((entered_tx, resume_rx)));
		let source_for_replace = source.clone();
		let destination_for_replace = destination.clone();
		let replace = thread::spawn(move || {
			platform::exact_replace_path(
				&source_for_replace,
				&destination_for_replace,
				&expected_source,
				&expected_destination,
			)
		});
		entered_rx
			.recv()
			.expect("wait for exact replacement exchange");
		fs::rename(&source, &predecessor).expect("retain authorized predecessor");
		fs::write(&source, b"attacker").expect("substitute source name");
		resume_tx.send(()).expect("resume exact replacement");
		let result = replace.join().expect("exact replacement thread");
		platform::set_exact_replace_after_exchange_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(result.retained_unknown_path, None);
		assert_eq!(fs::read(&destination).expect("read committed successor"), b"successor");
		assert_eq!(fs::read(&predecessor).expect("read retained source link"), b"successor");
		assert_eq!(fs::read(&source).expect("read substituted source"), b"attacker");
	}

	#[test]
	fn exact_replace_path_preserves_substituted_destination_after_exchange() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		let successor = temporary.0.join("retained-successor");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_exact_replace_after_exchange_hook(Some((entered_tx, resume_rx)));
		let source_for_replace = source.clone();
		let destination_for_replace = destination.clone();
		let replace = thread::spawn(move || {
			platform::exact_replace_path(
				&source_for_replace,
				&destination_for_replace,
				&expected_source,
				&expected_destination,
			)
		});
		entered_rx
			.recv()
			.expect("wait for exact replacement exchange");
		fs::rename(&destination, &successor).expect("retain committed successor");
		fs::write(&destination, b"attacker").expect("substitute destination name");
		resume_tx.send(()).expect("resume exact replacement");
		let result = replace.join().expect("exact replacement thread");
		platform::set_exact_replace_after_exchange_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		let detached = result
			.detached_path
			.as_deref()
			.expect("retained private predecessor path");
		assert_eq!(
			result.retained_unknown_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(result.retained_successor_path, None);
		assert_eq!(fs::read(&successor).expect("read retained successor"), b"successor");
		assert_eq!(fs::read(&source).expect("read retained source link"), b"successor");
		assert_eq!(fs::read(detached).expect("read retained predecessor"), b"predecessor");
		assert_eq!(fs::read(&destination).expect("read substituted destination"), b"attacker");
	}

	#[test]
	fn exact_replace_path_preserves_successor_moved_before_final_verification() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_exact_replace_before_final_verify_hook(Some((entered_tx, resume_rx)));
		let source_for_replace = source.clone();
		let destination_for_replace = destination.clone();
		let replace = thread::spawn(move || {
			platform::exact_replace_path(
				&source_for_replace,
				&destination_for_replace,
				&expected_source,
				&expected_destination,
			)
		});
		entered_rx
			.recv()
			.expect("wait for final replacement verification");
		fs::rename(&destination, &source).expect("move committed successor back to staging");
		fs::write(&destination, b"attacker").expect("substitute destination name");
		resume_tx
			.send(())
			.expect("resume final replacement verification");
		let result = replace.join().expect("exact replacement thread");
		platform::set_exact_replace_before_final_verify_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.detached_path.as_deref(), Some(source.to_string_lossy().as_ref()));
		assert_eq!(
			result.retained_unknown_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(fs::read(&source).expect("read retained successor"), b"successor");
		assert_eq!(fs::read(&destination).expect("read substituted destination"), b"attacker");
	}

	#[test]
	fn exact_replace_path_reports_both_names_after_post_cleanup_substitution() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		let retained_successor = temporary.0.join("retained-successor");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_exact_replace_before_final_verify_hook(Some((entered_tx, resume_rx)));
		let source_for_replace = source.clone();
		let destination_for_replace = destination.clone();
		let replace = thread::spawn(move || {
			platform::exact_replace_path(
				&source_for_replace,
				&destination_for_replace,
				&expected_source,
				&expected_destination,
			)
		});
		entered_rx
			.recv()
			.expect("wait for final replacement verification");
		fs::rename(&destination, &retained_successor).expect("retain committed successor");
		fs::write(&source, b"attacker-source").expect("substitute source name");
		fs::write(&destination, b"attacker-destination").expect("substitute destination name");
		resume_tx
			.send(())
			.expect("resume final replacement verification");
		let result = replace.join().expect("exact replacement thread");
		platform::set_exact_replace_before_final_verify_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.detached_path.as_deref(), Some(source.to_string_lossy().as_ref()));
		assert_eq!(
			result.retained_unknown_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(fs::read(&retained_successor).expect("read retained successor"), b"successor");
		assert_eq!(fs::read(&source).expect("read substituted source"), b"attacker-source");
		assert_eq!(
			fs::read(&destination).expect("read substituted destination"),
			b"attacker-destination"
		);
	}
	#[test]
	fn exact_replace_path_reports_predecessor_when_retirement_exchange_fails() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("session.replacement");
		let destination = temporary.0.join("session.jsonl");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		platform::inject_rename_exchange_failure(2);

		let result = platform::exact_replace_path(
			&source,
			&destination,
			&expected_source,
			&expected_destination,
		);
		platform::inject_rename_exchange_failure(0);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("identity_mismatch"));
		assert_eq!(result.detached_path, None);
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert_eq!(fs::read(&source).expect("read retained source link"), b"successor");
		assert_eq!(fs::read(&destination).expect("read committed successor"), b"successor");
	}
	#[test]
	fn exact_replace_path_reports_predecessor_when_exchange_fsync_fails() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		platform::inject_root_parent_fsync_failure(1);

		let result = platform::exact_replace_path(
			&source,
			&destination,
			&expected_source,
			&expected_destination,
		);
		platform::inject_root_parent_fsync_failure(0);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("durability_failed"));
		assert_eq!(result.detached_path, None);
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert!(!source.exists());
		assert_eq!(fs::read(&destination).expect("read committed successor"), b"successor");
	}

	#[test]
	fn exact_replace_path_reports_successor_when_final_fsync_fails() {
		let _guard = EXACT_REPLACE_HOOK_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let source = temporary.0.join("staging");
		let destination = temporary.0.join("session.json");
		fs::write(&source, b"successor").expect("seed staged successor");
		fs::write(&destination, b"predecessor").expect("seed destination predecessor");
		let expected_source = identity(&source, &temporary.0, b"successor");
		let expected_destination = identity(&destination, &temporary.0, b"predecessor");
		platform::inject_root_parent_fsync_failure(1);

		let result = platform::exact_replace_path(
			&source,
			&destination,
			&expected_source,
			&expected_destination,
		);
		platform::inject_root_parent_fsync_failure(0);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("durability_failed"));
		assert_eq!(result.detached_path, None);
		assert_eq!(
			result.retained_successor_path.as_deref(),
			Some(destination.to_string_lossy().as_ref())
		);
		assert!(!source.exists());
		assert_eq!(fs::read(&destination).expect("read committed successor"), b"successor");
	}
}

#[cfg(all(test, unix))]
mod secure_skill_write_tests {
	use std::{
		fs,
		path::PathBuf,
		sync::{
			atomic::{AtomicU64, Ordering},
			mpsc,
		},
		thread,
	};

	use super::{PATH_IDENTITY_HOOK_TEST_LOCK, platform, secure_write_skill_file};

	static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let path = std::env::temp_dir().join(format!(
				"gjc-secure-skill-write-{}-{}",
				std::process::id(),
				NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir(&path).expect("create secure skill-write temp directory");
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn creates_missing_skill_tree_and_overwrites_regular_file() {
		let _guard = PATH_IDENTITY_HOOK_TEST_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let first = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"first".to_owned(),
			None,
		);
		assert!(first.ok, "{:?}", first.code);
		let path = root.join("managed").join("SKILL.md");
		assert_eq!(fs::read_to_string(&path).expect("read first write"), "first");

		let second = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"second".to_owned(),
			None,
		);
		assert!(second.ok, "{:?}", second.code);
		assert_eq!(fs::read_to_string(&path).expect("read overwrite"), "second");
		assert_eq!(second.path.as_deref(), Some(path.to_string_lossy().as_ref()));
	}

	#[test]
	fn rejects_symlinked_skill_root_skill_directory_and_file() {
		let _guard = PATH_IDENTITY_HOOK_TEST_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let assert_rejected_link = |code: Option<&str>| {
			assert!(
				matches!(code, Some("reparse_point" | "not_directory")),
				"unexpected code: {code:?}"
			);
		};
		let temporary = TempDir::new();
		let outside = temporary.0.join("outside");
		fs::create_dir(&outside).expect("create outside directory");
		let gjc = temporary.0.join(".gjc");
		std::os::unix::fs::symlink(&outside, &gjc).expect("create .gjc symlink");
		let gjc_result = secure_write_skill_file(
			gjc.join("skills").to_string_lossy().into_owned(),
			"managed".to_owned(),
			"blocked".to_owned(),
			None,
		);
		assert_rejected_link(gjc_result.code.as_deref());

		fs::remove_file(&gjc).expect("remove .gjc symlink");
		fs::create_dir(&gjc).expect("create real .gjc directory");
		let root = gjc.join("skills");
		std::os::unix::fs::symlink(&outside, &root).expect("create skills symlink");
		let root_result = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"blocked".to_owned(),
			None,
		);
		assert_rejected_link(root_result.code.as_deref());

		fs::remove_file(&root).expect("remove skills symlink");
		fs::create_dir(&root).expect("create real skills directory");
		let skill_link = root.join("managed");
		std::os::unix::fs::symlink(&outside, &skill_link).expect("create skill symlink");
		let skill_result = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"blocked".to_owned(),
			None,
		);
		assert_rejected_link(skill_result.code.as_deref());

		fs::remove_file(&skill_link).expect("remove skill symlink");
		fs::create_dir(&skill_link).expect("create real skill directory");
		let outside_file = outside.join("SKILL.md");
		fs::write(&outside_file, "outside").expect("seed outside file");
		std::os::unix::fs::symlink(&outside_file, skill_link.join("SKILL.md"))
			.expect("create file symlink");
		let file_result = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"blocked".to_owned(),
			None,
		);
		assert_rejected_link(file_result.code.as_deref());
		assert_eq!(fs::read_to_string(&outside_file).expect("read outside file"), "outside");

		fs::remove_file(skill_link.join("SKILL.md")).expect("remove file symlink");
		fs::hard_link(&outside_file, skill_link.join("SKILL.md")).expect("create hard link");
		let hard_link_result = secure_write_skill_file(
			root.to_string_lossy().into_owned(),
			"managed".to_owned(),
			"blocked".to_owned(),
			None,
		);
		assert_eq!(hard_link_result.code.as_deref(), Some("hard_link"));
		assert_eq!(
			fs::read_to_string(outside_file).expect("read hard-linked outside file"),
			"outside"
		);
	}

	#[test]
	fn late_hard_link_swap_replaces_only_the_final_name() {
		let _guard = PATH_IDENTITY_HOOK_TEST_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		fs::create_dir_all(&skill).expect("create skill directory");
		let final_path = skill.join("SKILL.md");
		let outside = temporary.0.join("outside.md");
		fs::write(&final_path, "before").expect("seed final file");
		fs::write(&outside, "outside").expect("seed external file");

		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_before_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"after".to_owned(),
				None,
			)
		});
		entered_rx.recv().expect("wait for private-file write");
		fs::remove_file(&final_path).expect("remove final name");
		fs::hard_link(&outside, &final_path).expect("install late hard-link alias");
		resume_tx.send(()).expect("release private-file write");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_before_rename_hook(None);

		assert!(result.ok, "{:?}", result.code);
		assert_eq!(fs::read_to_string(&outside).expect("read external file"), "outside");
		assert_eq!(fs::read_to_string(&final_path).expect("read published file"), "after");
	}

	#[test]
	fn private_file_hard_link_is_rejected_and_scrubbed() {
		let _guard = PATH_IDENTITY_HOOK_TEST_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let skill = root.join("managed");
		let outside = temporary.0.join("private-alias.md");
		let (entered_tx, entered_rx) = mpsc::channel();
		let (resume_tx, resume_rx) = mpsc::channel();
		platform::set_secure_skill_write_before_rename_hook(Some((entered_tx, resume_rx)));
		let root_for_write = root.clone();
		let writer = thread::spawn(move || {
			secure_write_skill_file(
				root_for_write.to_string_lossy().into_owned(),
				"managed".to_owned(),
				"secret-stage".to_owned(),
				None,
			)
		});
		entered_rx.recv().expect("wait for private-file write");
		let private = fs::read_dir(&skill)
			.expect("read skill directory")
			.map(|entry| entry.expect("read private entry").path())
			.find(|path| {
				path
					.file_name()
					.is_some_and(|name| name.to_string_lossy().starts_with(".gjc-skill-write-"))
			})
			.expect("private skill file");
		fs::hard_link(&private, &outside).expect("link private staging file");
		platform::inject_secure_skill_cleanup_failure(true);
		resume_tx.send(()).expect("release private-file write");
		let result = writer.join().expect("secure skill writer thread");
		platform::set_secure_skill_write_before_rename_hook(None);

		assert!(!result.ok);
		assert_eq!(result.code.as_deref(), Some("cleanup_failed"));
		assert_eq!(fs::read(&outside).expect("read scrubbed private alias"), b"");
		assert_eq!(fs::read(&private).expect("read retained scrubbed private file"), b"");
		assert!(!skill.join("SKILL.md").exists());
	}

	#[test]
	fn concurrent_writers_publish_complete_payloads() {
		let _guard = PATH_IDENTITY_HOOK_TEST_LOCK
			.lock()
			.unwrap_or_else(|poisoned| poisoned.into_inner());
		let temporary = TempDir::new();
		let root = temporary.0.join(".gjc").join("skills");
		let payloads: Vec<String> = (0..8)
			.map(|index| format!("payload-{index}-{}", "x".repeat(32 * 1024)))
			.collect();
		let workers: Vec<_> = payloads
			.iter()
			.cloned()
			.map(|content| {
				let root = root.clone();
				thread::spawn(move || {
					secure_write_skill_file(
						root.to_string_lossy().into_owned(),
						"managed".to_owned(),
						content,
						None,
					)
				})
			})
			.collect();
		for worker in workers {
			let result = worker.join().expect("secure skill writer worker");
			assert!(result.ok, "{:?}", result.code);
		}
		let final_contents = fs::read_to_string(root.join("managed").join("SKILL.md"))
			.expect("read concurrent final file");
		assert!(payloads.iter().any(|payload| payload == &final_contents));
	}
}

#[cfg(test)]
mod sha256_tests {
	use std::io::{self, Read};

	use super::{digest_reader, sha256};
	fn hex(digest: [u8; 32]) -> String {
		digest.iter().map(|byte| format!("{byte:02x}")).collect()
	}

	#[test]
	fn sha256_matches_known_answers_and_block_boundaries() {
		assert_eq!(
			hex(sha256(b"")),
			"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
		);
		assert_eq!(
			hex(sha256(b"abc")),
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
		);
		for length in [55, 56, 63, 64, 65] {
			let bytes = vec![b'a'; length];
			let mut reader = bytes.as_slice();
			assert_eq!(digest_reader(&mut reader).unwrap(), sha256(&bytes));
		}
	}

	#[test]
	fn digest_reader_streams_large_files_in_bounded_reads() {
		struct ChunkedReader {
			bytes:    Vec<u8>,
			offset:   usize,
			max_read: usize,
		}

		impl Read for ChunkedReader {
			fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
				let remaining = &self.bytes[self.offset..];
				let count = remaining.len().min(buffer.len()).min(self.max_read);
				buffer[..count].copy_from_slice(&remaining[..count]);
				self.offset += count;
				Ok(count)
			}
		}

		let bytes = (0..(1024 * 1024 + 17))
			.map(|index| (index % 251) as u8)
			.collect();
		let mut reader = ChunkedReader { bytes, offset: 0, max_read: 1021 };
		let digest = digest_reader(&mut reader).unwrap();
		assert_eq!(reader.offset, reader.bytes.len());
		assert_eq!(digest, sha256(&reader.bytes));
	}
}
