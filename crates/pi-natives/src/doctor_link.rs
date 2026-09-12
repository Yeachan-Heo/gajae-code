//! Exact managed-link swap primitive for doctor repairs.
//!
//! Every mutation is descriptor-relative: the destination's parent directory
//! is opened once (no-follow, component-by-component) and retained as a file
//! descriptor. All identity checks and the atomic exchange/no-replace publish
//! run against that one retained descriptor plus bare basenames — never a
//! re-resolved path — so a symlinked or replaced parent directory cannot
//! smuggle a mutation into a different directory than the one validated.
//!
//! The swap itself uses the platform atomic name-exchange primitive
//! (`renameat2(RENAME_EXCHANGE)` on Linux, `renameatx_np(RENAME_SWAP)` on
//! macOS) rather than lstat-then-`fs::rename`: the two names either swap
//! completely or the call fails outright, so there is no window in which a
//! concurrent writer's object at the destination name could be silently
//! discarded. The retired link is moved out of the staged slot with a
//! no-replace rename so a foreign occupant at the quarantine name is refused,
//! never overwritten or deleted.
use napi_derive::napi;

#[napi(object)]
pub struct DoctorLinkSwapResult {
	pub status:   String,
	pub changed:  bool,
	pub verified: bool,
	pub code:     Option<String>,
}

fn outcome(
	status: &str,
	changed: bool,
	verified: bool,
	code: Option<&str>,
) -> DoctorLinkSwapResult {
	DoctorLinkSwapResult { status: status.into(), changed, verified, code: code.map(str::to_owned) }
}

/// Protocol version for [`exact_swap_managed_link`]'s argument contract.
///
/// The caller checks this before staging anything so a stale addon (old
/// argument order/count) is refused up front rather than discovered
/// mid-mutation.
#[napi]
pub const fn get_doctor_link_protocol_version() -> u32 {
	2
}

/// Exchange a staged symlink with the expected destination using the platform
/// atomic name-exchange primitive.
///
/// The destination's parent is retained as a single opened descriptor for
/// every check and mutation. The retired link is moved into `quarantine_path`
/// with a no-replace rename; it is never deleted and a foreign occupant at
/// any of the three names is always refused rather than overwritten.
#[napi]
#[allow(
	clippy::too_many_arguments,
	reason = "exact identity binding for every checked object requires one argument per field; a \
	          struct would not change the safety property"
)]
pub fn exact_swap_managed_link(
	staged_path: String,
	destination_path: String,
	quarantine_path: String,
	parent_dev: String,
	parent_ino: String,
	old_dev: String,
	old_ino: String,
	old_target: String,
	staged_dev: String,
	staged_ino: String,
	new_target: String,
) -> DoctorLinkSwapResult {
	#[cfg(unix)]
	{
		unix_impl::swap(
			&staged_path,
			&destination_path,
			&quarantine_path,
			&parent_dev,
			&parent_ino,
			&old_dev,
			&old_ino,
			&old_target,
			&staged_dev,
			&staged_ino,
			&new_target,
		)
	}
	#[cfg(not(unix))]
	{
		let _ = (
			staged_path,
			destination_path,
			quarantine_path,
			parent_dev,
			parent_ino,
			old_dev,
			old_ino,
			old_target,
			staged_dev,
			staged_ino,
			new_target,
		);
		outcome("unsupported", false, false, Some("unsupported_platform"))
	}
}

#[cfg(unix)]
mod unix_impl {
	use std::{
		borrow::Cow,
		ffi::CString,
		fs::File,
		io,
		os::{
			fd::{AsRawFd, FromRawFd},
			unix::ffi::OsStrExt,
		},
		path::{Component, Path},
	};

	use super::{DoctorLinkSwapResult, outcome};

	const EINTR_RETRY_LIMIT: u32 = 8;

	#[cfg(target_os = "macos")]
	unsafe extern "C" {
		fn renameatx_np(
			fromfd: libc::c_int,
			from: *const libc::c_char,
			tofd: libc::c_int,
			to: *const libc::c_char,
			flags: libc::c_uint,
		) -> libc::c_int;
	}

	#[cfg(target_os = "macos")]
	unsafe extern "C" {
		fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
		fn acl_get_entry(
			acl: *mut libc::c_void,
			entry_id: libc::c_int,
			entry: *mut *mut libc::c_void,
		) -> libc::c_int;
		fn acl_free(object: *mut libc::c_void) -> libc::c_int;
	}

	/// macOS aliases `/tmp`, `/var`, and `/etc` to `/private/...` via a
	/// top-level symlink. A no-follow descriptor walk of the alias form would
	/// refuse at the first component even though the path is not
	/// attacker-controlled — this mirrors `path_identity.rs`'s
	/// `descriptor_walk_path` so temp-file parents (e.g. `os.tmpdir()`)
	/// resolve the same way here that they do for the rest of the native layer.
	#[allow(
		clippy::missing_const_for_fn,
		reason = "macOS alias normalization uses non-const Path operations"
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

	/// Open a directory purely by descriptor, walking every path component with
	/// `O_NOFOLLOW`. A symlink anywhere in the chain — including the final
	/// component — is refused rather than followed.
	fn open_directory_no_follow(dir: &Path) -> Result<File, &'static str> {
		let walk = descriptor_walk_path(dir);
		let dir = walk.as_ref();
		let base: &[u8] = if dir.is_absolute() { b"/\0" } else { b".\0" };
		// SAFETY: base is a static NUL-terminated path; the flags request a
		// no-follow directory descriptor.
		let mut fd = unsafe {
			libc::open(
				base.as_ptr().cast(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if fd < 0 {
			return Err("parent_open_failed");
		}
		for component in dir.components() {
			match component {
				Component::Normal(segment) => {
					let name = CString::new(segment.as_bytes()).map_err(|_| "invalid_path")?;
					// SAFETY: zero is a valid initialized representation for this output struct.
					let mut named: libc::stat = unsafe { std::mem::zeroed() };
					// SAFETY: fd is a live descriptor, name is NUL-terminated, and named is
					// writable.
					if unsafe { libc::fstatat(fd, name.as_ptr(), &mut named, libc::AT_SYMLINK_NOFOLLOW) }
						!= 0
					{
						// SAFETY: this branch owns the live descriptor and closes it exactly once.
						unsafe { libc::close(fd) };
						return Err("parent_open_failed");
					}
					if named.st_mode & libc::S_IFMT == libc::S_IFLNK {
						// SAFETY: this branch owns the live descriptor and closes it exactly once.
						unsafe { libc::close(fd) };
						return Err("parent_reparse_point");
					}
					// SAFETY: fd is live and name is a validated NUL-terminated component.
					let next = unsafe {
						libc::openat(
							fd,
							name.as_ptr(),
							libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
						)
					};
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(fd) };
					if next < 0 {
						return Err("parent_open_failed");
					}
					fd = next;
				},
				Component::RootDir | Component::CurDir => {},
				Component::ParentDir | Component::Prefix(_) => {
					// SAFETY: this branch owns the live descriptor and closes it exactly once.
					unsafe { libc::close(fd) };
					return Err("invalid_path");
				},
			}
		}
		// SAFETY: fd is a newly owned successful open/openat result.
		Ok(unsafe { File::from_raw_fd(fd) })
	}

	fn fstat(fd: libc::c_int) -> Result<libc::stat, &'static str> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut st: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: fd is a live descriptor and st is writable.
		if unsafe { libc::fstat(fd, &mut st) } != 0 {
			return Err("io_error");
		}
		Ok(st)
	}

	fn fstatat_no_follow(dir_fd: libc::c_int, name: &CString) -> Result<libc::stat, &'static str> {
		// SAFETY: zero is a valid initialized representation for this output struct.
		let mut st: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: dir_fd is a live descriptor, name is NUL-terminated, and st is
		// writable.
		if unsafe { libc::fstatat(dir_fd, name.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
			return Err("not_found");
		}
		Ok(st)
	}

	fn readlinkat_string(dir_fd: libc::c_int, name: &CString) -> Result<String, &'static str> {
		let mut buffer = vec![0u8; 4096];
		// SAFETY: dir_fd is live, name is NUL-terminated, and buffer is writable with
		// its given length.
		let read = unsafe {
			libc::readlinkat(dir_fd, name.as_ptr(), buffer.as_mut_ptr().cast(), buffer.len())
		};
		if read < 0 || (read as usize) >= buffer.len() {
			return Err("unreadable");
		}
		buffer.truncate(read as usize);
		String::from_utf8(buffer).map_err(|_| "unreadable")
	}

	#[cfg(target_os = "linux")]
	fn parent_acl_absent(dir: &File) -> Result<(), &'static str> {
		let name = b"system.posix_acl_access\0";
		// SAFETY: dir is a live descriptor and name is a static NUL-terminated xattr
		// name; a null zero-length buffer is a size query.
		let result =
			unsafe { libc::fgetxattr(dir.as_raw_fd(), name.as_ptr().cast(), std::ptr::null_mut(), 0) };
		if result >= 0 {
			return Err("parent_acl_present");
		}
		match io::Error::last_os_error().raw_os_error() {
			Some(libc::ENODATA) => Ok(()),
			Some(e) if e == libc::EOPNOTSUPP || e == libc::ENOTSUP => Ok(()),
			_ => Err("parent_acl_query_failed"),
		}
	}

	#[cfg(target_os = "macos")]
	fn parent_acl_absent(dir: &File) -> Result<(), &'static str> {
		// SAFETY: dir is a live descriptor; the returned ACL allocation is freed
		// exactly once below.
		let acl = unsafe { acl_get_fd(dir.as_raw_fd()) };
		if acl.is_null() {
			let errno = io::Error::last_os_error().raw_os_error();
			return if matches!(errno, Some(libc::ENOENT | libc::ENOTSUP)) {
				Ok(())
			} else {
				Err("parent_acl_query_failed")
			};
		}
		let mut entry = std::ptr::null_mut();
		// SAFETY: acl is a live allocation from the preceding call and entry is a
		// writable output pointer.
		let result = unsafe { acl_get_entry(acl, 0, &mut entry) };
		// SAFETY: this owns the ACL allocation from acl_get_fd and frees it exactly
		// once.
		unsafe { acl_free(acl) };
		if result == 0 {
			Err("parent_acl_present")
		} else {
			Ok(())
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn parent_acl_absent(_dir: &File) -> Result<(), &'static str> {
		Err("acl_unavailable")
	}

	#[cfg(target_os = "linux")]
	fn exchange(dir_fd: libc::c_int, a: &CString, b: &CString) -> Result<(), &'static str> {
		for _ in 0..EINTR_RETRY_LIMIT {
			// SAFETY: dir_fd is live and both CStrings are NUL-terminated.
			let rc = unsafe {
				libc::syscall(
					libc::SYS_renameat2,
					dir_fd,
					a.as_ptr(),
					dir_fd,
					b.as_ptr(),
					libc::RENAME_EXCHANGE,
				)
			};
			if rc == 0 {
				return Ok(());
			}
			match io::Error::last_os_error().raw_os_error() {
				Some(libc::EINTR) => {},
				Some(libc::ENOSYS | libc::EINVAL) => return Err("atomic_swap_unavailable"),
				_ => return Err("exchange_failed"),
			}
		}
		Err("interrupted")
	}

	#[cfg(target_os = "macos")]
	fn exchange(dir_fd: libc::c_int, a: &CString, b: &CString) -> Result<(), &'static str> {
		const RENAME_SWAP: libc::c_uint = 0x0000_0002;
		for _ in 0..EINTR_RETRY_LIMIT {
			// SAFETY: dir_fd is live and both CStrings are NUL-terminated.
			let rc = unsafe { renameatx_np(dir_fd, a.as_ptr(), dir_fd, b.as_ptr(), RENAME_SWAP) };
			if rc == 0 {
				return Ok(());
			}
			match io::Error::last_os_error().raw_os_error() {
				Some(libc::EINTR) => {},
				Some(libc::ENOSYS | libc::EINVAL) => return Err("atomic_swap_unavailable"),
				_ => return Err("exchange_failed"),
			}
		}
		Err("interrupted")
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn exchange(_dir_fd: libc::c_int, _a: &CString, _b: &CString) -> Result<(), &'static str> {
		Err("atomic_swap_unavailable")
	}

	#[cfg(target_os = "linux")]
	fn rename_no_replace(dir_fd: libc::c_int, a: &CString, b: &CString) -> Result<(), &'static str> {
		for _ in 0..EINTR_RETRY_LIMIT {
			// SAFETY: dir_fd is live and both CStrings are NUL-terminated.
			let rc = unsafe {
				libc::syscall(
					libc::SYS_renameat2,
					dir_fd,
					a.as_ptr(),
					dir_fd,
					b.as_ptr(),
					libc::RENAME_NOREPLACE,
				)
			};
			if rc == 0 {
				return Ok(());
			}
			match io::Error::last_os_error().raw_os_error() {
				Some(libc::EINTR) => {},
				Some(libc::EEXIST) => return Err("quarantine_occupied"),
				_ => return Err("quarantine_move_failed"),
			}
		}
		Err("interrupted")
	}

	#[cfg(target_os = "macos")]
	fn rename_no_replace(dir_fd: libc::c_int, a: &CString, b: &CString) -> Result<(), &'static str> {
		const RENAME_EXCL: libc::c_uint = 0x0000_0004;
		for _ in 0..EINTR_RETRY_LIMIT {
			// SAFETY: dir_fd is live and both CStrings are NUL-terminated.
			let rc = unsafe { renameatx_np(dir_fd, a.as_ptr(), dir_fd, b.as_ptr(), RENAME_EXCL) };
			if rc == 0 {
				return Ok(());
			}
			match io::Error::last_os_error().raw_os_error() {
				Some(libc::EINTR) => {},
				Some(libc::EEXIST) => return Err("quarantine_occupied"),
				_ => return Err("quarantine_move_failed"),
			}
		}
		Err("interrupted")
	}

	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	fn rename_no_replace(
		_dir_fd: libc::c_int,
		_a: &CString,
		_b: &CString,
	) -> Result<(), &'static str> {
		Err("atomic_unavailable")
	}

	#[allow(clippy::unnecessary_cast, reason = "libc stat field widths differ between Unix targets")]
	const fn symlink_identity(st: &libc::stat) -> Option<(u64, u64)> {
		if st.st_mode & libc::S_IFMT != libc::S_IFLNK {
			return None;
		}
		Some((st.st_dev as u64, st.st_ino as u64))
	}

	#[allow(clippy::too_many_arguments, reason = "mirrors the public napi signature 1:1")]
	pub(super) fn swap(
		staged_path: &str,
		destination_path: &str,
		quarantine_path: &str,
		parent_dev: &str,
		parent_ino: &str,
		old_dev: &str,
		old_ino: &str,
		old_target: &str,
		staged_dev: &str,
		staged_ino: &str,
		new_target: &str,
	) -> DoctorLinkSwapResult {
		if cfg!(not(any(target_os = "linux", target_os = "macos"))) {
			return outcome("unsupported", false, false, Some("unsupported_platform"));
		}
		let staged = Path::new(staged_path);
		let destination = Path::new(destination_path);
		let quarantine = Path::new(quarantine_path);
		let (Some(dest_dir), Some(staged_dir), Some(quarantine_dir)) =
			(destination.parent(), staged.parent(), quarantine.parent())
		else {
			return outcome("refused", false, false, Some("invalid_path"));
		};
		if staged_dir != dest_dir || quarantine_dir != dest_dir {
			return outcome("refused", false, false, Some("paths_not_same_parent"));
		}
		let (Some(dest_name), Some(staged_name), Some(quarantine_name)) =
			(destination.file_name(), staged.file_name(), quarantine.file_name())
		else {
			return outcome("refused", false, false, Some("invalid_path"));
		};
		let (Ok(dest_cname), Ok(staged_cname), Ok(quarantine_cname)) = (
			CString::new(dest_name.as_bytes()),
			CString::new(staged_name.as_bytes()),
			CString::new(quarantine_name.as_bytes()),
		) else {
			return outcome("refused", false, false, Some("invalid_path"));
		};

		let dir = match open_directory_no_follow(dest_dir) {
			Ok(dir) => dir,
			Err(code) => return outcome("refused", false, false, Some(code)),
		};
		let dir_stat = match fstat(dir.as_raw_fd()) {
			Ok(st) => st,
			Err(code) => return outcome("refused", false, false, Some(code)),
		};
		// SAFETY: geteuid has no preconditions and only reads process credentials.
		if dir_stat.st_uid != unsafe { libc::geteuid() } || dir_stat.st_mode & 0o022 != 0 {
			return outcome("refused", false, false, Some("parent_ownership_or_write_shared"));
		}
		if dir_stat.st_dev.to_string() != parent_dev || dir_stat.st_ino.to_string() != parent_ino {
			return outcome("refused", false, false, Some("parent_identity_mismatch"));
		}
		if let Err(code) = parent_acl_absent(&dir) {
			return outcome("refused", false, false, Some(code));
		}

		let staged_stat = match fstatat_no_follow(dir.as_raw_fd(), &staged_cname) {
			Ok(st) => st,
			Err(code) => return outcome("refused", false, false, Some(code)),
		};
		let Some(staged_id) = symlink_identity(&staged_stat) else {
			return outcome("refused", false, false, Some("staged_not_symlink"));
		};
		// Validate the live staged object against the caller's ORIGINAL snapshot
		// (taken immediately after the caller created it), not a freshly observed
		// identity promoted to authority here. A fresh-only check would accept
		// whatever object currently occupies the staged name even if it was
		// swapped out from under the caller between staging and this call.
		if staged_id.0.to_string() != staged_dev || staged_id.1.to_string() != staged_ino {
			return outcome("refused", false, false, Some("staged_identity_mismatch"));
		}
		match readlinkat_string(dir.as_raw_fd(), &staged_cname) {
			Ok(target) if target == new_target => {},
			Ok(_) => return outcome("refused", false, false, Some("staged_target_mismatch")),
			Err(code) => return outcome("refused", false, false, Some(code)),
		}

		let dest_stat = match fstatat_no_follow(dir.as_raw_fd(), &dest_cname) {
			Ok(st) => st,
			Err(code) => return outcome("refused", false, false, Some(code)),
		};
		let Some(old_id) = symlink_identity(&dest_stat) else {
			return outcome("refused", false, false, Some("destination_not_symlink"));
		};
		if old_id.0.to_string() != old_dev || old_id.1.to_string() != old_ino {
			return outcome("refused", false, false, Some("destination_identity_mismatch"));
		}
		match readlinkat_string(dir.as_raw_fd(), &dest_cname) {
			Ok(target) if target == old_target => {},
			Ok(_) => return outcome("refused", false, false, Some("destination_target_mismatch")),
			Err(code) => return outcome("refused", false, false, Some(code)),
		}

		if fstatat_no_follow(dir.as_raw_fd(), &quarantine_cname).is_ok() {
			return outcome("refused", false, false, Some("quarantine_occupied"));
		}

		if let Err(code) = exchange(dir.as_raw_fd(), &staged_cname, &dest_cname) {
			return outcome(
				if code == "atomic_swap_unavailable" {
					"unsupported"
				} else {
					"failed"
				},
				false,
				false,
				Some(code),
			);
		}

		// Independent post-effect verification against the same retained descriptor:
		// the exchange is atomic and kernel-guaranteed, but this call never trusts its
		// own success return without re-observing the exact resulting identities and
		// targets.
		let Ok(dest_after) = fstatat_no_follow(dir.as_raw_fd(), &dest_cname) else {
			return outcome("uncertain", true, false, Some("post_swap_destination_unreadable"));
		};
		let Ok(staged_after) = fstatat_no_follow(dir.as_raw_fd(), &staged_cname) else {
			return outcome("uncertain", true, false, Some("post_swap_staged_unreadable"));
		};
		let dest_ok = symlink_identity(&dest_after) == Some(staged_id)
			&& readlinkat_string(dir.as_raw_fd(), &dest_cname).as_deref() == Ok(new_target);
		let staged_ok = symlink_identity(&staged_after) == Some(old_id)
			&& readlinkat_string(dir.as_raw_fd(), &staged_cname).as_deref() == Ok(old_target);
		if !dest_ok || !staged_ok {
			return outcome("uncertain", true, false, Some("post_swap_binding_mismatch"));
		}

		// The retired link is now at the staged name; move it into quarantine with a
		// no-replace rename so a foreign occupant there is refused, never overwritten.
		// A failure here does not roll back the already-verified destination swap — it
		// only means the retired link stays retained at the staged path instead.
		match rename_no_replace(dir.as_raw_fd(), &staged_cname, &quarantine_cname) {
			Ok(()) => outcome("verified", true, true, Some("old_artifact_retained_at_quarantine")),
			Err(_) => outcome("verified", true, true, Some("old_artifact_retained_at_staged_path")),
		}
	}
}
