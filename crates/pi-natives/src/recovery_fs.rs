//! Linux-only descriptor-relative filesystem authority for crash recovery.
//!
//! Every operation is rooted in the directory descriptor acquired by
//! [`open_recovery_fs_root`]. Relative names are walked one component at a
//! time without following symlinks, and regular files must be single-linked.

#[cfg(target_os = "linux")]
use std::{
	ffi::CString,
	fs::File,
	io::{Read, Seek, SeekFrom, Write},
	os::fd::{AsRawFd, FromRawFd},
	path::{Component, Path},
	sync::atomic::{AtomicU64, Ordering},
};

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
#[cfg(target_os = "linux")]
use parking_lot::Mutex;
#[cfg(target_os = "linux")]
use sha2::{Digest, Sha256};

const MAX_CONTENT_BYTES: u64 = 1024 * 1024;
const MAX_MANAGED_CONTENT_BYTES: u64 = 64 * 1024 * 1024;
const MAX_MANAGED_TREE_DEPTH: usize = 32;
const MAX_MANAGED_TREE_FILES: u64 = 10_000;
const MAX_MANAGED_TREE_TOTAL_BYTES: u64 = 512 * 1024 * 1024;

#[cfg(target_os = "linux")]
static MANAGED_REPLACEMENT_ID: AtomicU64 = AtomicU64::new(0);

#[napi(object)]
#[derive(PartialEq, Eq)]

pub struct RecoveryFsIdentity {
	pub dev:      String,
	pub ino:      String,
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
			with_root_and_recovery(&self.root, &self.recovery, |root, recovery| {
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
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery(&self.root, &self.recovery, |root, recovery| {
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
			RecoveryFsResult::failure("unsupported_platform")
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
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
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
			RecoveryFsResult::failure("unsupported_platform")
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
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root(&self.root, |root| {
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
			RecoveryFsResult::failure("unsupported_platform")
		}
	}

	/// Remove an exact managed directory tree through retained authority.
	#[napi]
	pub fn remove_managed_tree(
		&self,
		relative_path: String,
		expected: crate::path_identity::NativeDirectoryTreeSnapshot,
	) -> RecoveryFsResult {
		#[cfg(target_os = "linux")]
		{
			with_root_and_recovery(&self.root, &self.recovery, |root, recovery| {
				remove_managed_tree(root, recovery, &relative_path, &expected)
			})
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (relative_path, expected);
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
fn with_root_and_recovery(
	root: &Mutex<Option<File>>,
	recovery: &Mutex<Option<File>>,
	operation: impl FnOnce(&File, Option<&File>) -> Result<RecoveryFsResult, &'static str>,
) -> RecoveryFsResult {
	let root_guard = root.lock();
	let Some(root) = root_guard.as_ref() else {
		return RecoveryFsResult::failure("closed");
	};
	let recovery_guard = recovery.lock();
	operation(root, recovery_guard.as_ref()).unwrap_or_else(RecoveryFsResult::failure)
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
) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::AsRawFd;
	let source_file = open_existing(root, source, false)?;
	crate::path_identity::platform::verify_created_owner_only_file(&source_file)?;
	if !same_expected(&source_file, dev, ino, size, mtime_ns, ctime_ns, sha256)? {
		return Err("identity_mismatch");
	}

	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	// SAFETY: both parents are retained descriptors, names are validated, and
	// RENAME_NOREPLACE is atomic.
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
	let moved_file = open_existing(root, destination, false)?;
	crate::path_identity::platform::verify_created_owner_only_file(&moved_file)?;
	let moved = regular_identity(&moved_file)?;
	if !same_expected_after_rename(&moved_file, dev, ino, size, mtime_ns, sha256)? {
		return Err("rollback_unavailable");
	}
	let terminal =
		statat(&destination_parent, &destination_name).map_err(|_| "identity_mismatch")?;
	if terminal.st_dev.to_string() != moved.dev || terminal.st_ino.to_string() != moved.ino {
		return Err("rollback_unavailable");
	}
	if source_parent.sync_all().is_err() || destination_parent.sync_all().is_err() {
		return Err("rollback_unavailable");
	}
	let after = regular_identity(&moved_file)?;
	let named_after =
		statat(&destination_parent, &destination_name).map_err(|_| "identity_mismatch")?;
	crate::path_identity::platform::verify_created_owner_only_file(&moved_file)?;
	let after_digest = digest_hex(&moved_file)?;
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
		return Err("rollback_unavailable");
	}
	Ok(RecoveryFsResult::success(moved))
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
) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::AsRawFd;
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
	// SAFETY: parent is retained, names are validated, and quarantine rename is
	// no-replace atomic.
	if unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			source_parent.as_raw_fd(),
			name.as_ptr(),
			recovery_parent.as_raw_fd(),
			quarantine.as_ptr(),
			libc::RENAME_NOREPLACE,
		)
	} != 0
	{
		return Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::ENOSYS | libc::EINVAL) => "atomic_unavailable",
			_ => "io_error",
		});
	}
	let quarantined_relative = quarantine.to_str().map_err(|_| "io_error")?;
	let verified =
		open_existing(&recovery_parent, quarantined_relative, false).and_then(|detached| {
			let identity = regular_identity(&detached)?;
			if identity.dev != authorized_identity.dev
				|| identity.ino != authorized_identity.ino
				|| !same_expected_after_rename(
					&detached,
					expected_dev,
					expected_ino,
					expected_size,
					expected_mtime_ns,
					expected_sha256,
				)? {
				Err("identity_mismatch")
			} else {
				Ok(())
			}
		});
	if verified.is_err() {
		return Err("rollback_unavailable");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&authorized)?;
	let post_detach_identity = regular_identity(&authorized)?;
	if digest_hex(&authorized)? != expected_sha256 {
		return Err("rollback_unavailable");
	}
	if source_parent.sync_all().is_err() || recovery_parent.sync_all().is_err() {
		return Err("rollback_unavailable");
	}
	crate::path_identity::platform::verify_created_owner_only_file(&authorized)?;
	let terminal_identity = regular_identity(&authorized)?;
	let terminal_digest = digest_hex(&authorized)?;
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
	// Canonical absence is committed. The verified quarantine remains recoverable
	// evidence; deleting it would reopen an unprovable name race.
	Ok(RecoveryFsResult::success(authorized_identity))
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
		return Err("too_large");
	};
	if appended_size > MAX_MANAGED_CONTENT_BYTES {
		return Err("too_large");
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
	let identity = regular_identity(&file)?;
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
	use std::os::fd::AsRawFd;
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
		.transpose()?
		.ok_or("io_error")?;
	let candidate_file = open_existing(&recovery_parent, &candidate, false)?;
	let candidate_identity = regular_identity(&candidate_file)?;
	crate::path_identity::platform::verify_created_owner_only_file(&candidate_file)?;
	if digest_hex(&candidate_file)? != hex_digest(Sha256::digest(data).into()) {
		return Err("identity_mismatch");
	}
	let candidate_parent = recovery_parent;
	let candidate_name = CString::new(candidate).map_err(|_| "io_error")?;
	let (destination_parent, destination_name) = open_parent(root, relative_path)?;
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
	} != 0
	{
		return Err("io_error");
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
		|| digest_hex(&replacement)? != hex_digest(Sha256::digest(data).into())
		|| digest_hex(&displaced)? != expected_sha256
		|| !stat_matches_regular_identity(&terminal_replacement, &terminal_replacement_identity)
		|| !stat_matches_regular_identity(&terminal_displaced, &terminal_displaced_identity)
	{
		return Err("identity_mismatch");
	}
	// Publication is committed. The verified displaced object remains recoverable
	// evidence; deleting it would reopen an unprovable name race.
	Ok(RecoveryFsResult::success(replacement_identity))
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
	if budget.entries > MAX_MANAGED_TREE_FILES {
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
					libc::openat(fd, name.as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW)
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
) -> Result<RecoveryFsResult, &'static str> {
	let before = snapshot_managed_tree(root, source)?
		.snapshot
		.ok_or("io_error")?;
	if &before != expected {
		return Err("identity_mismatch");
	}
	let (source_parent, source_name) = open_parent(root, source)?;
	let (destination_parent, destination_name) = open_parent(root, destination)?;
	// SAFETY: both parents are retained, names are validated, and RENAME_NOREPLACE
	// is atomic.
	if unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			source_parent.as_raw_fd(),
			source_name.as_ptr(),
			destination_parent.as_raw_fd(),
			destination_name.as_ptr(),
			libc::RENAME_NOREPLACE,
		)
	} != 0
	{
		return Err(match std::io::Error::last_os_error().raw_os_error() {
			Some(libc::EEXIST) => "already_exists",
			Some(libc::ENOSYS | libc::EINVAL) => "atomic_unavailable",
			_ => "io_error",
		});
	}
	let post_mutation = (|| -> Result<RecoveryFsIdentity, &'static str> {
		let after = snapshot_managed_tree(root, destination)?
			.snapshot
			.ok_or("io_error")?;
		if !tree_matches_after_rename(&after, expected) {
			return Err("identity_mismatch");
		}
		source_parent.sync_all().map_err(|_| "fsync_failed")?;
		destination_parent.sync_all().map_err(|_| "fsync_failed")?;
		let terminal = snapshot_managed_tree(root, destination)?
			.snapshot
			.ok_or("io_error")?;
		if terminal != after {
			return Err("identity_mismatch");
		}
		let destination_root = open_existing_directory(root, destination)?;
		let destination_identity = identity(&destination_root)?;
		if destination_identity.dev != expected.root_dev
			|| destination_identity.ino != expected.root_ino
		{
			return Err("identity_mismatch");
		}
		Ok(destination_identity)
	})();
	match post_mutation {
		Ok(identity) => Ok(RecoveryFsResult::success(identity)),
		Err(_) => Err("rollback_unavailable"),
	}
}

#[cfg(target_os = "linux")]
fn remove_managed_tree(
	root: &File,
	recovery: Option<&File>,
	relative_path: &str,
	expected: &crate::path_identity::NativeDirectoryTreeSnapshot,
) -> Result<RecoveryFsResult, &'static str> {
	use std::os::fd::AsRawFd;
	let snapshot = snapshot_managed_tree(root, relative_path)?
		.snapshot
		.ok_or("io_error")?;
	if &snapshot != expected {
		return Err("identity_mismatch");
	}
	let root_identity = identity(root)?;
	let (source_parent, name) = open_parent(root, relative_path)?;
	let quarantine = CString::new(format!(
		".gjc-managed-tree-remove-{}-{}",
		std::process::id(),
		MANAGED_REPLACEMENT_ID.fetch_add(1, Ordering::Relaxed)
	))
	.map_err(|_| "io_error")?;
	let recovery_parent = recovery_directory(root, recovery)?;
	// SAFETY: retained parent and validated names make the detach no-replace
	// atomic.
	if unsafe {
		libc::syscall(
			libc::SYS_renameat2,
			source_parent.as_raw_fd(),
			name.as_ptr(),
			recovery_parent.as_raw_fd(),
			quarantine.as_ptr(),
			libc::RENAME_NOREPLACE,
		)
	} != 0
	{
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
	// Canonical absence is durable. The verified quarantine remains as recoverable
	// cleanup evidence; deleting descendants here would reopen a destructive race
	// with a concurrent same-UID actor.
	Ok(RecoveryFsResult::success(root_identity))
}
