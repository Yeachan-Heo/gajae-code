//! Canonical directory identity and fail-closed path security helpers.

use std::{
	io::{self, Read},
	path::{Component, Path, PathBuf},
};

use napi::{
	JsString,
	bindgen_prelude::{BigInt, Either, Uint8Array},
};
use napi_derive::napi;
use parking_lot::Mutex;
use sha2::{Digest, Sha256};

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

/// Retained no-follow authority for the SDK publication namespace.
#[napi]
pub struct NativeRetainedBrokerPublication {
	inner: Mutex<Option<publication::RetainedPublication>>,
}

#[napi]
impl NativeRetainedBrokerPublication {
	#[napi]
	pub fn observe(&self) -> NativeBrokerPublicationObservation {
		let guard = self.inner.lock();
		NativeBrokerPublicationObservation {
			kind: guard
				.as_ref()
				.map_or_else(|| "ambiguous".to_owned(), publication::RetainedPublication::observe),
		}
	}

	#[napi]
	pub fn heartbeat(&self, heartbeat_at: String) -> NativeBrokerPublicationOperation {
		let mut guard = self.inner.lock();
		NativeBrokerPublicationOperation {
			kind: guard.as_mut().map_or_else(
				|| "closed".to_owned(),
				|publication| publication.heartbeat(&heartbeat_at),
			),
		}
	}

	#[napi]
	pub fn sync(&self) -> NativeBrokerPublicationOperation {
		let guard = self.inner.lock();
		NativeBrokerPublicationOperation {
			kind: guard
				.as_ref()
				.map_or_else(|| "closed".to_owned(), publication::RetainedPublication::sync),
		}
	}

	/// Close discovery, owner record, lock directory, and SDK root in that
	/// order.
	#[napi]
	pub fn close(&self) -> NativeBrokerPublicationOperation {
		let mut guard = self.inner.lock();
		guard.take();
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
		publication::RetainedPublication::open(Path::new(&agent_dir)).ok_or_else(|| {
			napi::Error::from_reason("Retained broker publication authority is unavailable.")
		})?;
	Ok(NativeRetainedBrokerPublication { inner: Mutex::new(Some(publication)) })
}

/// Result of resolving an existing directory to its stable platform identity.
#[napi(object)]
pub struct NativeCanonicalDirectoryIdentity {
	pub ok:             bool,
	pub platform:       Option<String>,
	pub canonical_path: Option<String>,
	pub code:           Option<String>,
}

/// Result of applying or checking owner-only path security.
#[napi(object)]
pub struct NativeOwnerOnlySecurityResult {
	pub ok:   bool,
	pub code: Option<String>,
}

/// Caller-supplied identity and preauthorized quarantine evidence for exact
/// deletion.

#[napi(object)]
pub struct NativeExactFileIdentity {
	pub dev:             BigInt,
	pub ino:             BigInt,
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
}

struct ExactFileIdentity {
	dev:             u64,
	ino:             u64,
	size:            u64,
	mtime_ns:        i64,
	directory:       bool,
	detach_only:     bool,
	quarantine_name: Option<String>,
	sha256:          Option<[u8; 32]>,
}
/// Typed result of an identity-bound regular-file deletion or directory detach.
#[napi(object)]
pub struct NativeExactUnlinkResult {
	pub ok:            bool,
	pub code:          Option<String>,
	pub detached_path: Option<String>,
}

/// A deterministic, no-follow description of a directory tree. `relative_path`
/// is UTF-8, uses `/` separators, and is empty only for the root entry.
#[napi(object)]
#[derive(Clone, PartialEq, Eq)]
pub struct NativeDirectoryTreeEntry {
	pub relative_path: String,
	pub kind:          String,
	pub dev:           String,
	pub ino:           String,
	pub size:          String,
	pub mtime_ns:      String,
	pub sha256:        Option<String>,
}

/// Stable evidence returned by `snapshot_directory_tree` and consumed verbatim
/// by `exact_remove_directory_tree`.
#[napi(object)]
#[derive(Clone, PartialEq, Eq)]
pub struct NativeDirectoryTreeSnapshot {
	pub root_dev: String,
	pub root_ino: String,
	pub entries:  Vec<NativeDirectoryTreeEntry>,
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
		Self { ok: true, code: None, detached_path: None }
	}

	const fn detached(path: String) -> Self {
		Self { ok: true, code: None, detached_path: Some(path) }
	}

	fn detached_failure(code: &str, path: String) -> Self {
		Self { ok: false, code: Some(code.to_owned()), detached_path: Some(path) }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()), detached_path: None }
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

fn digest_reader(reader: &mut impl Read) -> io::Result<[u8; 32]> {
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
		size,
		mtime_ns,
		directory: identity.directory.unwrap_or(false),
		detach_only: identity.detach_only.unwrap_or(false),
		quarantine_name,
		sha256,
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
	const fn success() -> Self {
		Self { ok: true, code: None }
	}

	fn failure(code: &str) -> Self {
		Self { ok: false, code: Some(code.to_owned()) }
	}
}

fn io_code(error: &io::Error) -> &'static str {
	match error.kind() {
		io::ErrorKind::NotFound => "not_found",
		io::ErrorKind::InvalidInput | io::ErrorKind::NotADirectory => "not_directory",
		_ => "io_error",
	}
}

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

/// Restore only the detached object that still has the supplied platform
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
) -> NativeExactUnlinkResult {
	if source_path.contains('\0') || destination_path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	platform::rename_path_no_replace(Path::new(&source_path), Path::new(&destination_path))
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

/// Remove an already durably planned detached directory only when a fresh
#[cfg_attr(clippy, doc = "")]
/// descriptor-relative snapshot exactly equals the persisted snapshot. The
/// caller-planned root remains in place while its opened descriptor is
/// authoritative throughout recursive removal.
#[napi]
pub fn exact_remove_directory_tree(
	path: String,
	snapshot: NativeDirectoryTreeSnapshot,
) -> NativeExactUnlinkResult {
	if path.contains('\0') {
		return NativeExactUnlinkResult::failure("io_error");
	}
	platform::exact_remove_directory_tree(Path::new(&path), &snapshot)
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

	fn open(path: &Path, directory: bool, write: bool) -> Option<File> {
		open_result(path, directory, write).ok()
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
		pub(super) fn open(agent_dir: &Path) -> Option<Self> {
			let root = open(&agent_dir.join("sdk"), true, false)?;
			let lock = open(&agent_dir.join("sdk/broker.lock"), true, false)?;
			let owner = open(&agent_dir.join("sdk/broker.lock/owner.json"), false, false)?;
			let discovery = open(&agent_dir.join("sdk/broker.json"), false, true)?;
			let mut readable = discovery.try_clone().ok()?;
			let mut bytes = Vec::new();
			readable.read_to_end(&mut bytes).ok()?;
			let needle = b"\"heartbeatAt\":";
			let start = bytes
				.windows(needle.len())
				.position(|window| window == needle)?
				+ needle.len();
			if bytes
				.get(start..start + 13)?
				.iter()
				.any(|byte| !byte.is_ascii_digit())
				|| bytes.get(start + 13).is_some_and(u8::is_ascii_digit)
			{
				return None;
			}
			Some(Self {
				root_identity: Identity::of(&root)?,
				lock_identity: Identity::of(&lock)?,
				owner_identity: Identity::of(&owner)?,
				discovery_identity: Identity::of(&discovery)?,
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

#[cfg(not(unix))]
mod publication {
	use std::path::Path;

	/// Windows retained HANDLE/FileIdInfo authority is intentionally unavailable
	/// until its reparse-safe implementation lands; acquisition fails closed.
	pub(super) struct RetainedPublication;
	impl RetainedPublication {
		pub(super) fn open(_: &Path) -> Option<Self> {
			None
		}

		pub(super) fn observe(&self) -> String {
			"ambiguous".to_owned()
		}

		pub(super) fn heartbeat(&mut self, _: &str) -> String {
			"ambiguous".to_owned()
		}

		pub(super) fn sync(&self) -> String {
			"ambiguous".to_owned()
		}
	}
}
#[cfg(unix)]
mod platform {
	use std::{
		ffi::CString,
		fmt::Write as _,
		fs::{self, File},
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::{
				ffi::OsStrExt,
				fs::{MetadataExt, PermissionsExt},
			},
		},
		path::{Component, Path},
	};

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeEntry,
		NativeDirectoryTreeResult, NativeDirectoryTreeSnapshot, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, digest_reader, io_code, security_io_code, sha256,
	};

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

	fn checked_file(
		path: &Path,
		kind: &str,
	) -> Result<(File, fs::Metadata), NativeOwnerOnlySecurityResult> {
		if !matches!(kind, "directory" | "file") {
			return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
		}

		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let mut fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if fd < 0 {
			return Err(NativeOwnerOnlySecurityResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}

		let segments: Vec<Vec<u8>> = path
			.components()
			.filter_map(|component| match component {
				Component::Normal(segment) => Some(segment.as_bytes().to_vec()),
				Component::ParentDir => Some(b"..".to_vec()),
				Component::RootDir | Component::CurDir => None,
				Component::Prefix(_) => None,
			})
			.collect();
		for (index, segment) in segments.iter().enumerate() {
			let Ok(segment) = CString::new(segment.as_slice()) else {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe {
					libc::close(fd);
				}
				return Err(NativeOwnerOnlySecurityResult::failure("io_error"));
			};
			// SAFETY: zero is a valid initialized representation for this output struct.
			let mut named: libc::stat = unsafe { std::mem::zeroed() };
			// SAFETY: the descriptor and CString are live; the initialized output struct is
			// writable.
			if unsafe { libc::fstatat(fd, segment.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
				!= 0
			{
				let error = std::io::Error::last_os_error();
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe {
					libc::close(fd);
				}
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(&error)));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe {
					libc::close(fd);
				}
				return Err(NativeOwnerOnlySecurityResult::failure("reparse_point"));
			}
			let mut flags = libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW;
			if index + 1 < segments.len() || kind == "directory" {
				flags |= libc::O_DIRECTORY;
			}
			// SAFETY: the live descriptor, where used, and NUL-terminated path remain
			// valid.
			let next_fd = unsafe { libc::openat(fd, segment.as_ptr(), flags) };
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe {
				libc::close(fd);
			}
			if next_fd < 0 {
				return Err(NativeOwnerOnlySecurityResult::failure(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
			fd = next_fd;
		}

		// SAFETY: this uniquely transfers the live descriptor to `File` ownership.
		let file = unsafe { File::from_raw_fd(fd) };
		let metadata = file
			.metadata()
			.map_err(|error| NativeOwnerOnlySecurityResult::failure(security_code(&error)))?;
		if (kind == "directory" && !metadata.is_dir()) || (kind == "file" && !metadata.is_file()) {
			return Err(NativeOwnerOnlySecurityResult::failure("not_directory"));
		}
		Ok((file, metadata))
	}

	#[cfg(target_os = "linux")]
	fn clear_extended_acl(file: &File) -> Result<(), NativeOwnerOnlySecurityResult> {
		let name = b"system.posix_acl_access\0";
		// SAFETY: the file descriptor and NUL-terminated attribute name remain valid.
		let result = unsafe { libc::fremovexattr(file.as_raw_fd(), name.as_ptr().cast()) };
		if result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
			Ok(())
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "linux")]
	fn has_extended_acl(file: &File) -> Result<bool, NativeOwnerOnlySecurityResult> {
		let name = b"system.posix_acl_access\0";
		// SAFETY: the file descriptor and NUL-terminated attribute name remain valid.
		let result = unsafe {
			libc::fgetxattr(file.as_raw_fd(), name.as_ptr().cast(), std::ptr::null_mut(), 0)
		};
		if result >= 0 {
			Ok(true)
		} else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENODATA) {
			Ok(false)
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
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
	fn clear_extended_acl(file: &File) -> Result<(), NativeOwnerOnlySecurityResult> {
		// SAFETY: this creates an owned ACL allocation for the requested entry count.
		let acl = unsafe { acl_init(1) };
		if acl.is_null() {
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		// SAFETY: the file descriptor and owned ACL allocation remain live for this
		// call.
		let result = unsafe { acl_set_fd(file.as_raw_fd(), acl) };
		// SAFETY: this owns the ACL allocation from the preceding ACL API and frees it
		// once.
		unsafe { acl_free(acl) };
		if result == 0 {
			Ok(())
		} else {
			Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"))
		}
	}

	#[cfg(target_os = "macos")]
	fn has_extended_acl(file: &File) -> Result<bool, NativeOwnerOnlySecurityResult> {
		// SAFETY: the file descriptor is live; the returned ACL is freed exactly once.
		let acl = unsafe { acl_get_fd(file.as_raw_fd()) };
		if acl.is_null() {
			// On macOS `acl_get_fd` returns NULL with errno ENOENT when the file has no
			// extended ACL; that is the common case, not a failure.
			if std::io::Error::last_os_error().raw_os_error() == Some(libc::ENOENT) {
				return Ok(false);
			}
			return Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable"));
		}
		let mut entry = std::ptr::null_mut();
		// SAFETY: the ACL allocation is live and `entry` is a writable output pointer.
		let result = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) };
		// SAFETY: this owns the ACL allocation from the preceding ACL API and frees it
		// once.
		unsafe { acl_free(acl) };
		// Unlike Linux, macOS `acl_get_entry` returns 0 when it hands back an entry and
		// -1 once no entries remain, so a first-entry success means the file carries an
		// extended ACL.
		match result {
			0 => Ok(true),
			-1 => Ok(false),
			_ => Err(NativeOwnerOnlySecurityResult::failure("acl_unavailable")),
		}
	}

	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let (file, metadata) = match checked_file(path, kind) {
			Ok(result) => result,
			Err(result) => return result,
		};
		let mode = if metadata.is_dir() { 0o700 } else { 0o600 };
		let mut permissions = metadata.permissions();
		permissions.set_mode(mode);
		match file.set_permissions(permissions) {
			Ok(()) => {
				#[cfg(any(target_os = "linux", target_os = "macos"))]
				if let Err(result) = clear_extended_acl(&file) {
					return result;
				}
				verify_owner_only_path_security(path, kind)
			},
			Err(error) => NativeOwnerOnlySecurityResult::failure(security_code(&error)),
		}
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let (file, metadata) = match checked_file(path, kind) {
			Ok(result) => result,
			Err(result) => return result,
		};
		let expected = if metadata.is_dir() { 0o700 } else { 0o600 };
		// SAFETY: geteuid has no pointer, lifetime, or ownership requirements.
		if metadata.uid() != unsafe { libc::geteuid() }
			|| metadata.permissions().mode() & 0o777 != expected
		{
			return NativeOwnerOnlySecurityResult::failure("acl_verify_failed");
		}
		#[cfg(any(target_os = "linux", target_os = "macos"))]
		match has_extended_acl(&file) {
			Ok(false) => NativeOwnerOnlySecurityResult::success(),
			Ok(true) => NativeOwnerOnlySecurityResult::failure("acl_verify_failed"),
			Err(result) => result,
		}
		#[cfg(not(any(target_os = "linux", target_os = "macos")))]
		NativeOwnerOnlySecurityResult::failure("acl_unavailable")
	}
	#[cfg(target_os = "linux")]
	fn rename_no_replace(
		source_parent_fd: libc::c_int,
		destination_parent_fd: libc::c_int,
		source: &CString,
		destination: &CString,
	) -> Result<(), &'static str> {
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
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => Err("quarantine_collision"),
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
		// SAFETY: both descriptors and NUL-terminated CString pointers remain valid.
		if unsafe {
			renameatx_np(
				source_parent_fd,
				source.as_ptr(),
				destination_parent_fd,
				destination.as_ptr(),
				RENAME_EXCL,
			)
		} == 0
		{
			Ok(())
		} else {
			match std::io::Error::last_os_error().raw_os_error() {
				Some(libc::EEXIST) => Err("quarantine_collision"),
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

	pub(super) fn exact_unlink(
		path: &Path,
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return NativeExactUnlinkResult::failure(security_code(&std::io::Error::last_os_error()));
		}
		let mut segments = Vec::new();
		for component in path.components() {
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
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut named: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
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
		let expected_kind = if identity.directory {
			libc::S_IFDIR
		} else {
			libc::S_IFREG
		};
		if named.st_mode & libc::S_IFMT != expected_kind {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
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
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if !identity.directory
			&& digest_openat(parent_fd, &name).ok().as_ref() != identity.sha256.as_ref()
		{
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}

		let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("quarantine_destination_required");
		};
		let Ok(quarantine) = CString::new(quarantine_name) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure("io_error");
		};
		if let Err(code) = rename_no_replace(parent_fd, parent_fd, &name, &quarantine) {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(code);
		}
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
		if !matches {
			// Restoration refuses to clobber a replacement at the original name.
			let restored = rename_no_replace(parent_fd, parent_fd, &quarantine, &name).is_ok();
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref())
				.to_string_lossy()
				.into_owned();
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return if restored {
				NativeExactUnlinkResult::failure("identity_mismatch")
			} else {
				NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
			};
		}
		if !identity.directory
			&& digest_openat(parent_fd, &quarantine).ok().as_ref() != identity.sha256.as_ref()
		{
			// Restoration refuses to clobber a replacement at the original name.
			let restored = rename_no_replace(parent_fd, parent_fd, &quarantine, &name).is_ok();
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref())
				.to_string_lossy()
				.into_owned();
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return if restored {
				NativeExactUnlinkResult::failure("identity_mismatch")
			} else {
				NativeExactUnlinkResult::detached_failure("restore_failed", detached_path)
			};
		}
		if identity.directory || identity.detach_only {
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref());
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::detached(detached_path.to_string_lossy().into_owned());
		}
		// SAFETY: the parent descriptor and NUL-terminated CString path remain valid.
		let result = if unsafe { libc::unlinkat(parent_fd, quarantine.as_ptr(), 0) } == 0 {
			NativeExactUnlinkResult::success()
		} else {
			let detached_path = path
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(quarantine.to_string_lossy().as_ref());
			NativeExactUnlinkResult::detached_failure(
				security_code(&std::io::Error::last_os_error()),
				detached_path.to_string_lossy().into_owned(),
			)
		};

		// SAFETY: this branch owns the live descriptor and closes it exactly once.
		unsafe { libc::close(parent_fd) };
		result
	}

	fn open_parent_no_follow(
		path: &Path,
	) -> Result<(libc::c_int, CString), NativeExactUnlinkResult> {
		let base = if path.is_absolute() { b"/\0" } else { b".\0" };
		// SAFETY: the live descriptor, where used, and NUL-terminated path remain
		// valid.
		let mut parent_fd = unsafe {
			libc::open(base.as_ptr().cast(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC)
		};
		if parent_fd < 0 {
			return Err(NativeExactUnlinkResult::failure(security_code(
				&std::io::Error::last_os_error(),
			)));
		}
		let mut segments = Vec::new();
		for component in path.components() {
			match component {
				Component::Normal(segment) => segments.push(segment.as_bytes().to_vec()),
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(parent_fd) };
					return Err(NativeExactUnlinkResult::failure("io_error"));
				},
			}
		}
		let Some((name_bytes, ancestors)) = segments.split_last() else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return Err(NativeExactUnlinkResult::failure("io_error"));
		};
		for segment_bytes in ancestors {
			let Ok(segment) = CString::new(segment_bytes.as_slice()) else {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return Err(NativeExactUnlinkResult::failure("io_error"));
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
				return Err(NativeExactUnlinkResult::failure(security_code(&error)));
			}
			if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(parent_fd) };
				return Err(NativeExactUnlinkResult::failure("reparse_point"));
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
				return Err(NativeExactUnlinkResult::failure(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
			parent_fd = next_fd;
		}
		let Ok(name) = CString::new(name_bytes.as_slice()) else {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return Err(NativeExactUnlinkResult::failure("io_error"));
		};
		Ok((parent_fd, name))
	}

	pub(super) fn rename_path_no_replace(
		source_path: &Path,
		destination_path: &Path,
	) -> NativeExactUnlinkResult {
		let (source_parent, source_name) = match open_parent_no_follow(source_path) {
			Ok(value) => value,
			Err(result) => return result,
		};
		let (destination_parent, destination_name) = match open_parent_no_follow(destination_path) {
			Ok(value) => value,
			Err(result) => {
				// SAFETY: open_parent_no_follow returned this owned, live descriptor; this
				// error branch transfers it nowhere and closes it exactly once before
				// returning.
				unsafe { libc::close(source_parent) };
				return result;
			},
		};
		let result =
			rename_no_replace(source_parent, destination_parent, &source_name, &destination_name);
		// SAFETY: both descriptors are owned by this function, remained live through
		// the renameat2/renameatx_np call, and are each closed exactly once after the
		// syscall.
		unsafe {
			libc::close(source_parent);
			libc::close(destination_parent);
		}
		match result {
			Ok(()) => NativeExactUnlinkResult::success(),
			Err(code) => NativeExactUnlinkResult::failure(code),
		}
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
			Err(result) => return result,
		};
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
		if let Err(code) = rename_no_replace(parent_fd, parent_fd, &detached_name, &original_name) {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe { libc::close(parent_fd) };
			return NativeExactUnlinkResult::failure(if code == "quarantine_collision" {
				"collision"
			} else {
				code
			});
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
			size: (stat.st_size as u64).to_string(),
			mtime_ns: stat_mtime_ns(stat).to_string(),
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
		// SAFETY: `fd` is live; this function owns the returned duplicate.
		let duplicate = unsafe { libc::dup(fd) };
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
				libc::S_IFREG => entries.push(entry_from_stat(
					child_relative,
					&stat,
					"file",
					Some(hex_digest(digest_openat(fd, &name).map_err(|_| "io_error")?)),
				)),
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

	enum TreeRemovalFailure {
		Code(&'static str),
		Retained(&'static str),
	}

	fn expected_tree_entry<'a>(
		expected: &'a [NativeDirectoryTreeEntry],
		relative: &str,
	) -> Option<&'a NativeDirectoryTreeEntry> {
		expected
			.iter()
			.find(|entry| entry.relative_path == relative)
	}

	fn detached_entry_matches(
		parent_fd: libc::c_int,
		name: &CString,
		expected: &NativeDirectoryTreeEntry,
	) -> Result<bool, &'static str> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the descriptor and CString are live; the initialized output struct is
		// writable.
		if unsafe { libc::fstatat(parent_fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) }
			!= 0
		{
			return Err(security_code(&std::io::Error::last_os_error()));
		}
		let kind = match stat.st_mode & libc::S_IFMT {
			libc::S_IFREG => "file",
			libc::S_IFDIR => "directory",
			libc::S_IFLNK => return Ok(false),
			_ => return Ok(false),
		};
		if kind != expected.kind.as_str()
			|| stat.st_dev as u64 != expected.dev.parse().ok().unwrap_or(u64::MAX)
			|| stat.st_ino as u64 != expected.ino.parse().ok().unwrap_or(u64::MAX)
			|| (kind == "file"
				&& (stat.st_size as u64 != expected.size.parse().ok().unwrap_or(u64::MAX)
					|| stat_mtime_ns(&stat).to_string() != expected.mtime_ns))
		{
			return Ok(false);
		}
		if kind == "file" {
			let digest = hex_digest(digest_openat(parent_fd, name).map_err(|_| "io_error")?);
			return Ok(expected.sha256.as_deref() == Some(digest.as_str()));
		}
		Ok(expected.sha256.is_none())
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

	fn quarantine_child(
		parent_fd: libc::c_int,
		original: &CString,
		expected: &NativeDirectoryTreeEntry,
	) -> Result<CString, &'static str> {
		let candidate = tree_quarantine_name(expected);
		rename_no_replace(parent_fd, parent_fd, original, &candidate)?;
		Ok(candidate)
	}

	/// Validate the whole retained tree before starting any quarantine or
	/// deletion. Missing expected entries are permitted because a prior attempt
	/// may have completed their deletion, but every entry still present must
	/// map uniquely to its durable logical identity (including deterministic
	/// quarantine names).
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
			let (logical_bytes, expected_child) = match (expected_direct, expected_quarantined) {
				(Some(entry), None) => (name_bytes.clone(), entry),
				(None, Some(entry)) => (
					entry.relative_path.rsplit_once('/').map_or_else(
						|| entry.relative_path.as_bytes().to_vec(),
						|(_, name)| name.as_bytes().to_vec(),
					),
					entry,
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
				|| !detached_entry_matches(fd, &physical, expected_child)?
			{
				return Err("identity_mismatch");
			}
			if expected_child.kind == "directory" {
				// SAFETY: the live descriptor, where used, and NUL-terminated path remain
				// valid.
				let child = unsafe {
					libc::openat(
						fd,
						physical.as_ptr(),
						libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					)
				};
				if child < 0 {
					return Err(security_code(&std::io::Error::last_os_error()));
				}
				let result = validate_tree_fd(child, &child_relative, expected);
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(child) };
				result?;
			}
		}
		Ok(())
	}

	fn remove_tree_fd(
		fd: libc::c_int,
		relative: &str,
		expected: &[NativeDirectoryTreeEntry],
	) -> Result<(), TreeRemovalFailure> {
		let mut names = directory_names(fd).map_err(TreeRemovalFailure::Code)?;
		names.sort();
		let mut seen = std::collections::BTreeSet::new();
		for name_bytes in names {
			let physical =
				CString::new(name_bytes.clone()).map_err(|_| TreeRemovalFailure::Code("io_error"))?;
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
			let (logical_bytes, expected_child) = match (expected_direct, expected_quarantined) {
				(Some(entry), None) => (name_bytes.clone(), entry),
				(None, Some(entry)) => (
					entry.relative_path.rsplit_once('/').map_or_else(
						|| entry.relative_path.as_bytes().to_vec(),
						|(_, name)| name.as_bytes().to_vec(),
					),
					entry,
				),
				_ => return Err(TreeRemovalFailure::Code("identity_mismatch")),
			};
			let logical_name = std::str::from_utf8(&logical_bytes)
				.map_err(|_| TreeRemovalFailure::Code("not_utf8"))?;
			let child_relative = if relative.is_empty() {
				logical_name.to_owned()
			} else {
				format!("{relative}/{logical_name}")
			};
			if !seen.insert(child_relative.clone()) {
				return Err(TreeRemovalFailure::Code("identity_mismatch"));
			}
			if expected_tree_entry(expected, &child_relative) != Some(expected_child) {
				return Err(TreeRemovalFailure::Code("identity_mismatch"));
			}

			if physical.as_bytes() == logical_bytes.as_slice()
				&& !detached_entry_matches(fd, &physical, expected_child)
					.map_err(TreeRemovalFailure::Code)?
			{
				return Err(TreeRemovalFailure::Code("identity_mismatch"));
			}
			let detached = if physical.as_bytes() == logical_bytes.as_slice() {
				quarantine_child(fd, &physical, expected_child).map_err(TreeRemovalFailure::Code)?
			} else {
				physical
			};
			let matches = detached_entry_matches(fd, &detached, expected_child)
				.map_err(TreeRemovalFailure::Code)?;
			if !matches {
				return Err(TreeRemovalFailure::Retained("identity_mismatch"));
			}

			if expected_child.kind == "directory" {
				// SAFETY: the live descriptor, where used, and NUL-terminated path remain
				// valid.
				let child = unsafe {
					libc::openat(
						fd,
						detached.as_ptr(),
						libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					)
				};
				if child < 0 {
					return Err(TreeRemovalFailure::Retained(security_code(
						&std::io::Error::last_os_error(),
					)));
				}
				let result = remove_tree_fd(child, &child_relative, expected);
				// SAFETY: this branch owns the live descriptor and closes it exactly once.
				unsafe { libc::close(child) };
				result?;
				// SAFETY: the parent descriptor and NUL-terminated CString path remain valid.
				if unsafe { libc::unlinkat(fd, detached.as_ptr(), libc::AT_REMOVEDIR) } != 0 {
					return Err(TreeRemovalFailure::Retained(security_code(
						&std::io::Error::last_os_error(),
					)));
				}
			// SAFETY: the parent descriptor and NUL-terminated CString path remain
			// valid.
			} else if unsafe { libc::unlinkat(fd, detached.as_ptr(), 0) } != 0 {
				return Err(TreeRemovalFailure::Retained(security_code(
					&std::io::Error::last_os_error(),
				)));
			}
		}
		Ok(())
	}

	pub(super) fn exact_remove_directory_tree(
		path: &Path,
		expected: &NativeDirectoryTreeSnapshot,
	) -> NativeExactUnlinkResult {
		let planned_path = path.to_string_lossy().into_owned();
		let final_path = format!("{planned_path}.removing");
		let (parent, name) = match open_parent_no_follow(path) {
			Ok(value) => value,
			Err(result) => return result,
		};
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
		// SAFETY: `fd` is the live directory descriptor whose offset is reset.
		if unsafe { libc::lseek(fd, 0, libc::SEEK_SET) } < 0 {
			// SAFETY: this branch owns the live descriptor and closes it exactly once.
			unsafe {
				libc::close(fd);
				libc::close(parent);
			}
			return NativeExactUnlinkResult::detached_failure("io_error", retained_path);
		}
		let removal = remove_tree_fd(fd, "", &expected.entries);
		let result = match removal {
			Ok(()) if !already_final => match rename_no_replace(parent, parent, root_name, &final_name) {
				Ok(()) => {
					// SAFETY: zero is a valid initialized representation for this output struct.
					let mut retained: libc::stat = unsafe { std::mem::zeroed() };
					// SAFETY: the descriptor is live and the initialized output struct is writable.
					if unsafe { libc::fstat(fd, &mut retained) } != 0
						|| retained.st_dev as u64 != expected.root_dev.parse().ok().unwrap_or(u64::MAX)
						|| retained.st_ino as u64 != expected.root_ino.parse().ok().unwrap_or(u64::MAX)
					{
						NativeExactUnlinkResult::detached_failure("identity_mismatch", final_path)
					// SAFETY: the parent descriptor and NUL-terminated CString path remain valid.
					} else if unsafe { libc::unlinkat(parent, final_name.as_ptr(), libc::AT_REMOVEDIR) }
						== 0
					{
						NativeExactUnlinkResult::success()
					} else {
						NativeExactUnlinkResult::detached_failure(
							security_code(&std::io::Error::last_os_error()),
							final_path,
						)
					}
				},
				Err(code) => NativeExactUnlinkResult::detached_failure(code, planned_path),
			},
			Ok(())
				// SAFETY: the parent descriptor and NUL-terminated CString path remain valid.
				if unsafe { libc::unlinkat(parent, root_name.as_ptr(), libc::AT_REMOVEDIR) } == 0 =>
			{
				NativeExactUnlinkResult::success()
			},
			Ok(()) => NativeExactUnlinkResult::detached_failure(
				security_code(&std::io::Error::last_os_error()),
				retained_path,
			),
			Err(TreeRemovalFailure::Code(code) | TreeRemovalFailure::Retained(code)) => {
				NativeExactUnlinkResult::detached_failure(code, retained_path)
			},
		};
		// SAFETY: this branch owns the live descriptor and closes it exactly once.
		unsafe {
			libc::close(fd);
			libc::close(parent);
		}
		result
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		ffi::{OsString, c_void},
		mem::{align_of, size_of},
		os::windows::ffi::{OsStrExt, OsStringExt},
		path::{Component, Path, PathBuf},
		ptr::{null, null_mut},
	};

	use sha2::{Digest, Sha256};
	use windows_sys::Win32::{
		Foundation::{
			CloseHandle, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GENERIC_ALL, GetLastError,
			HANDLE, INVALID_HANDLE_VALUE, LocalFree,
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
			FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES, FileBasicInfo,
			FileDispositionInfo, GetFileInformationByHandle, GetFinalPathNameByHandleW, OPEN_EXISTING,
			READ_CONTROL, ReadFile, SetFileInformationByHandle, SetFilePointerEx, VOLUME_NAME_GUID,
			WRITE_DAC, WRITE_OWNER,
		},
		System::Threading::{GetCurrentProcess, OpenProcessToken},
	};

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeEntry,
		NativeDirectoryTreeResult, NativeDirectoryTreeSnapshot, NativeExactUnlinkResult,
		NativeOwnerOnlySecurityResult, sha256,
	};

	const SECURITY_OWNER_DACL: u32 = OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION;
	const SECURITY_OWNER_DACL_PROTECTED: u32 =
		SECURITY_OWNER_DACL | PROTECTED_DACL_SECURITY_INFORMATION;

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
			0xc000_0022 => "owner_mismatch",
			0xc000_050b => "reparse_point",
			0xc000_00d4 => "atomic_unavailable",
			_ => "io_error",
		}
	}

	fn open_relative(
		parent: HANDLE,
		name: &std::ffi::OsStr,
		desired_access: u32,
		directory: bool,
	) -> Result<HANDLE, &'static str> {
		let mut name: Vec<u16> = name.encode_wide().collect();
		if name.is_empty()
			|| name.iter().any(|unit| *unit == 0)
			|| name.len() > (u16::MAX as usize / 2)
		{
			return Err("io_error");
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
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				FILE_OPEN,
				options,
				null_mut(),
				0,
			)
		};
		if create_status < 0 {
			return Err(ntstatus_code(create_status));
		}
		Ok(handle)
	}

	fn open_exact(
		path: &Path,
		kind: &str,
		desired_access: u32,
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
			let handle = match open_relative(
				parent,
				name,
				if final_component {
					// Every final handle is validated with GetFileInformationByHandle before
					// use, so its caller-requested authority must also include attribute reads.
					desired_access | FILE_READ_ATTRIBUTES
				} else {
					// This retained directory becomes RootDirectory for the next
					// descriptor-relative NtCreateFile, which requires traversal
					// authority as well as attribute inspection.
					FILE_READ_ATTRIBUTES | FILE_TRAVERSE
				},
				if final_component {
					kind == "directory"
				} else {
					true
				},
			) {
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

	fn handles_same_object(left: HANDLE, right: HANDLE) -> bool {
		let mut left_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		let mut right_information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		(unsafe { GetFileInformationByHandle(left, &mut left_information) }) != 0
			&& (unsafe { GetFileInformationByHandle(right, &mut right_information) }) != 0
			&& left_information.dwVolumeSerialNumber == right_information.dwVolumeSerialNumber
			&& left_information.nFileIndexHigh == right_information.nFileIndexHigh
			&& left_information.nFileIndexLow == right_information.nFileIndexLow
	}

	fn rename_handle_no_replace(
		handle: HANDLE,
		parent_handle: HANDLE,
		name: &[u16],
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
			(*rename).replace_if_exists = 0;
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
		identity: &ExactFileIdentity,
	) -> NativeExactUnlinkResult {
		let detached_parent = match final_path(parent_handle) {
			Ok(path) => path,
			Err(code) => return NativeExactUnlinkResult::failure(code),
		};
		let name_wide: Vec<u16> = quarantine_name.encode_utf16().collect();
		let original_name_wide: Vec<u16> = source_name.encode_wide().collect();
		let result = match rename_handle_no_replace(handle, parent_handle, &name_wide) {
			Ok(()) => {
				let detached_path = Path::new(&detached_parent)
					.join(quarantine_name)
					.to_string_lossy()
					.into_owned();
				let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
				let matches = unsafe { GetFileInformationByHandle(handle, &mut information) } != 0
					&& handle_identity_matches(&information, identity)
					&& (identity.directory
						|| digest_handle(handle).ok().as_ref() == identity.sha256.as_ref());
				if matches {
					NativeExactUnlinkResult::detached(detached_path)
				} else if rename_handle_no_replace(handle, parent_handle, &original_name_wide).is_ok() {
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
		match rename_handle_no_replace(source.target, destination_parent.target, &destination_name) {
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
		let handle = match open_exact(path, kind, desired_access) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
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
		if !identity.directory
			&& digest_handle(handle.target).ok().as_ref() != identity.sha256.as_ref()
		{
			return NativeExactUnlinkResult::failure("identity_mismatch");
		}
		if identity.directory || identity.detach_only {
			let Some(quarantine_name) = identity.quarantine_name.as_deref() else {
				return NativeExactUnlinkResult::failure("quarantine_destination_required");
			};
			let Some(parent_handle) = handle.parent() else {
				return NativeExactUnlinkResult::failure("io_error");
			};
			let Some(original_name) = path.file_name() else {
				return NativeExactUnlinkResult::failure("io_error");
			};
			return detach_directory(
				handle.target,
				parent_handle,
				original_name,
				quarantine_name,
				identity,
			);
		}
		match delete_handle(handle.target) {
			Ok(()) => NativeExactUnlinkResult::success(),
			Err(code) => NativeExactUnlinkResult::failure(code),
		}
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
		let handle = match open_exact(
			detached_path,
			kind,
			FILE_READ_ATTRIBUTES
				| 0x0001_0000
				| if identity.directory {
					0
				} else {
					FILE_READ_DATA
				},
		) {
			Ok(handle) => handle,
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
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
		let result = detach_directory(
			handle.target,
			original_parent.target,
			source_name,
			quarantine_name,
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

	pub(super) fn apply_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, WRITE_OWNER | WRITE_DAC | READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		let dacl = match owner_only_dacl(&sid, kind) {
			Ok(dacl) => dacl,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_apply_failed"),
		};
		// SAFETY: the retained handle identifies the opened object; `sid` and aligned
		// `dacl` contain validated, live Windows security structures for this
		// synchronous call.
		let status = unsafe {
			SetSecurityInfo(
				handle.target,
				SE_FILE_OBJECT,
				SECURITY_OWNER_DACL_PROTECTED,
				sid.as_ptr().cast_mut().cast(),
				null_mut(),
				dacl.as_ptr().cast(),
				null_mut(),
			)
		};
		if status != 0 {
			return NativeOwnerOnlySecurityResult::failure("acl_apply_failed");
		}
		verify_owner_only_path_security(path, kind)
	}

	pub(super) fn verify_owner_only_path_security(
		path: &Path,
		kind: &str,
	) -> NativeOwnerOnlySecurityResult {
		let handle = match open_exact(path, kind, READ_CONTROL) {
			Ok(handle) => handle,
			Err(result) => return result,
		};
		let sid = match current_user_sid() {
			Ok(sid) => sid,
			Err(()) => return NativeOwnerOnlySecurityResult::failure("acl_unavailable"),
		};
		let mut owner = null_mut();
		let mut dacl = null_mut();
		let mut descriptor = null_mut();
		// SAFETY: the retained handle is valid and all output pointers are writable
		// until the returned LocalAlloc descriptor is released below.
		let status = unsafe {
			GetSecurityInfo(
				handle.target,
				SE_FILE_OBJECT,
				SECURITY_OWNER_DACL,
				&mut owner,
				null_mut(),
				&mut dacl,
				null_mut(),
				&mut descriptor,
			)
		};
		if status != 0 || descriptor.is_null() {
			return NativeOwnerOnlySecurityResult::failure("acl_unavailable");
		}
		if owner.is_null() {
			// SAFETY: GetSecurityInfo returned this live LocalAlloc descriptor, which is
			// released exactly once on this failure path.
			unsafe { LocalFree(descriptor) };
			return NativeOwnerOnlySecurityResult::failure("acl_unavailable");
		}
		// SAFETY: GetSecurityInfo returned owner within the live security descriptor;
		// `sid` is a validated current-user SID.
		let owner_matches = unsafe { EqualSid(owner, sid.as_ptr().cast_mut().cast()) } != 0;
		let mut control = 0u16;
		let mut revision = 0u32;
		// SAFETY: `descriptor` is the live allocation returned by GetSecurityInfo and
		// both outputs are writable local scalars.
		let protected_dacl = unsafe {
			windows_sys::Win32::Security::GetSecurityDescriptorControl(
				descriptor,
				&mut control,
				&mut revision,
			)
		} != 0 && control & SE_DACL_PROTECTED != 0;
		// SAFETY: zero is a valid output initialization for ACL_SIZE_INFORMATION.
		let mut acl_info: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
		let acl_ok = !dacl.is_null()
			// SAFETY: GetSecurityInfo returned `dacl` within its still-live descriptor and
			// `acl_info` is an aligned writable output of the exact checked size.
			&& unsafe {
				GetAclInformation(
					dacl,
					(&raw mut acl_info).cast(),
					u32::try_from(size_of::<ACL_SIZE_INFORMATION>()).expect("ACL info size fits u32"),
					AclSizeInformation,
				)
			} != 0;
		let expected_flags = if kind == "directory" {
			OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
		} else {
			0
		};
		let exact_owner_ace = if acl_ok && acl_info.AceCount == 1 {
			let acl_start = dacl as usize;
			let acl_bytes = acl_info.AclBytesInUse as usize;
			let acl_end = acl_start.checked_add(acl_bytes);
			let mut ace: *mut c_void = null_mut();
			// SAFETY: GetAclInformation validated the one-entry ACL in the live descriptor
			// and `ace` is a writable out-pointer.
			let got_ace = unsafe { GetAce(dacl, 0, &mut ace) } != 0;
			if got_ace && !ace.is_null() {
				let ace_start = ace as usize;
				let header_end = ace_start.checked_add(size_of::<ACE_HEADER>());
				if acl_bytes < size_of::<ACL>()
					|| ace_start < acl_start
					|| header_end.is_none_or(|end| acl_end.is_none_or(|acl_end| end > acl_end))
				{
					false
				} else {
					// SAFETY: the fixed ACE header range is fully bounded by AclBytesInUse;
					// unaligned read avoids imposing an alignment assumption on GetAce.
					let header = unsafe { std::ptr::read_unaligned(ace.cast::<ACE_HEADER>()) };
					let ace_size = usize::from(header.AceSize);
					let ace_end = ace_start.checked_add(ace_size);
					let sid_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, SidStart);
					let mask_offset = std::mem::offset_of!(ACCESS_ALLOWED_ACE, Mask);
					let minimum_ace_size = sid_offset.checked_add(sid.len()).unwrap_or(usize::MAX);
					if ace_size < minimum_ace_size
						|| mask_offset
							.checked_add(size_of::<u32>())
							.is_none_or(|end| end > ace_size)
						|| ace_end.is_none_or(|end| acl_end.is_none_or(|acl_end| end > acl_end))
						|| header.AceType != 0
						|| header.AceFlags != expected_flags
					{
						false
					} else {
						// SAFETY: the mask range is bounded by the validated ACE size and ACL extent.
						let mask = unsafe {
							std::ptr::read_unaligned(ace.cast::<u8>().add(mask_offset).cast::<u32>())
						};
						// SAFETY: the trailing SID range is bounded by both AceSize and
						// AclBytesInUse, and the descriptor remains live through comparison.
						let ace_sid = unsafe {
							std::slice::from_raw_parts(
								ace.cast::<u8>().add(sid_offset),
								ace_size - sid_offset,
							)
						};
						owner_only_ace_mask_is_safe(mask) && valid_sid(ace_sid).is_some()
							// SAFETY: both pointers identify complete validated SIDs that remain live.
							&& unsafe {
								EqualSid(ace_sid.as_ptr().cast_mut().cast(), sid.as_ptr().cast_mut().cast())
							} != 0
					}
				}
			} else {
				false
			}
		} else {
			false
		};
		// SAFETY: GetSecurityInfo allocated `descriptor` with LocalAlloc and it is
		// released once after all owner, ACL, and ACE reads have completed.
		unsafe { LocalFree(descriptor) };
		if owner_matches && protected_dacl && exact_owner_ace {
			NativeOwnerOnlySecurityResult::success()
		} else {
			NativeOwnerOnlySecurityResult::failure("acl_verify_failed")
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
			size: size.to_string(),
			mtime_ns: mtime_ns.to_string(),
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
		rename_handle_no_replace(handle, parent, &name)
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
			let child = open_relative(
				handle,
				&name_os,
				FILE_READ_ATTRIBUTES | FILE_READ_DATA | FILE_WRITE_ATTRIBUTES | 0x0001_0000,
				directory,
			)?;
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
							ok:            false,
							code:          result.code,
							detached_path: None,
						};
					},
				}
			},
			Err(result) => {
				return NativeExactUnlinkResult {
					ok:            false,
					code:          result.code,
					detached_path: None,
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
		match remove_tree_handle(root.target, "", &expected.entries) {
			Ok(()) if !already_final => {
				match rename_handle_no_replace(root.target, parent, &final_name) {
					Ok(()) => match tree_entry(root.target, String::new(), "directory") {
						Ok(entry) if entry.dev == expected.root_dev && entry.ino == expected.root_ino => {
							match delete_handle(root.target) {
								Ok(()) => NativeExactUnlinkResult::success(),
								Err(code) => NativeExactUnlinkResult::detached_failure(code, final_path),
							}
						},
						Ok(_) => {
							NativeExactUnlinkResult::detached_failure("identity_mismatch", final_path)
						},
						Err(code) => NativeExactUnlinkResult::detached_failure(code, final_path),
					},
					Err(code) => NativeExactUnlinkResult::detached_failure(code, planned_path),
				}
			},
			Ok(()) => match delete_handle(root.target) {
				Ok(()) => NativeExactUnlinkResult::success(),
				Err(code) => NativeExactUnlinkResult::detached_failure(code, retained_path),
			},
			Err(code) => NativeExactUnlinkResult::detached_failure(code, retained_path),
		}
	}
}

#[cfg(not(any(unix, windows)))]
mod platform {
	use std::path::Path;

	use super::{
		ExactFileIdentity, NativeCanonicalDirectoryIdentity, NativeDirectoryTreeResult,
		NativeDirectoryTreeSnapshot, NativeExactUnlinkResult, NativeOwnerOnlySecurityResult,
	};

	pub(super) fn canonical_existing_directory_identity(
		_: &Path,
	) -> NativeCanonicalDirectoryIdentity {
		NativeCanonicalDirectoryIdentity::failure("identity_unavailable")
	}
	pub(super) fn rename_path_no_replace(_: &Path, _: &Path) -> NativeExactUnlinkResult {
		NativeExactUnlinkResult::failure("atomic_unavailable")
	}
	pub(super) fn exact_unlink(_: &Path, _: &ExactFileIdentity) -> NativeExactUnlinkResult {
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
}
#[cfg(all(test, windows))]
mod owner_only_security_tests {
	use std::{
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{
		apply_owner_only_path_security, rename_no_replace_path, verify_owner_only_path_security,
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
		assert_eq!(std::fs::read(&destination).expect("read renamed destination"), b"source");

		let collision_source = dir.0.join("collision-source.tmp");
		std::fs::write(&collision_source, b"collision").expect("write collision source");
		let collision = rename_no_replace_path(
			collision_source.to_string_lossy().into_owned(),
			destination.to_string_lossy().into_owned(),
		);
		assert!(!collision.ok);
		assert_eq!(collision.code.as_deref(), Some("quarantine_collision"));
		assert_eq!(
			std::fs::read(&collision_source).expect("read retained collision source"),
			b"collision"
		);
		assert_eq!(std::fs::read(&destination).expect("read retained destination"), b"source");
	}
}
#[cfg(all(test, unix))]
mod retained_broker_publication_tests {
	use std::{
		path::PathBuf,
		sync::atomic::{AtomicU64, Ordering},
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

		let retained =
			NativeRetainedBrokerPublication { inner: parking_lot::Mutex::new(Some(publication)) };
		assert_eq!(retained.close().kind, "closed");
		assert_eq!(retained.heartbeat("1234567890777".to_owned()).kind, "closed");
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
