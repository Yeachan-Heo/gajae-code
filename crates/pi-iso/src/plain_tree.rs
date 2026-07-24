use std::{
	collections::BTreeMap,
	fs::File,
	io::{Read, Seek, SeekFrom},
	path::{Path, PathBuf},
};

use crate::{IsoError, IsoResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
	dev:       u64,
	ino:       u64,
	size:      u64,
	mtime_ns:  i128,
	change_ns: i128,
}

impl FileIdentity {
	const fn content_hint_eq(self, other: Self) -> bool {
		self.size == other.size
			&& self.mtime_ns.div_euclid(1_000_000_000) == other.mtime_ns.div_euclid(1_000_000_000)
	}
}

#[derive(Debug)]
pub enum PlainEntry {
	Regular(FileIdentity),
	Symlink(PathBuf),
}

impl PlainEntry {
	pub(super) const fn is_symlink(&self) -> bool {
		matches!(self, Self::Symlink(_))
	}

	pub(super) fn content_hint_eq(&self, other: &Self) -> bool {
		match (self, other) {
			(Self::Regular(left), Self::Regular(right)) => left.content_hint_eq(*right),
			(Self::Symlink(left), Self::Symlink(right)) => left == right,
			_ => false,
		}
	}
}

fn identity_changed(relative: &Path) -> IsoError {
	IsoError::other(format!(
		"plain-diff entry changed while it was being captured: {}",
		relative.display()
	))
}

pub struct PlainTree {
	pub entries: BTreeMap<PathBuf, PlainEntry>,
	root:        Option<File>,
}

impl PlainTree {
	pub(super) fn read(&self, relative: &Path) -> IsoResult<Vec<u8>> {
		let entry = self
			.entries
			.get(relative)
			.ok_or_else(|| IsoError::other("plain-diff entry disappeared from its index"))?;
		match entry {
			PlainEntry::Symlink(target) => Ok(target.as_os_str().as_encoded_bytes().to_vec()),
			PlainEntry::Regular(identity) => {
				let root = self
					.root
					.as_ref()
					.ok_or_else(|| IsoError::other("plain-diff root handle is unavailable"))?;
				let mut file = platform::open_regular(root, relative)?;
				let before = platform::file_identity(&file)?;
				if before != *identity {
					return Err(identity_changed(relative));
				}
				file.seek(SeekFrom::Start(0)).map_err(|err| {
					IsoError::other(format!(
						"rewind retained plain-diff handle {}: {err}",
						relative.display()
					))
				})?;
				let mut bytes = Vec::new();
				file.read_to_end(&mut bytes).map_err(|err| {
					IsoError::other(format!(
						"read retained plain-diff handle {}: {err}",
						relative.display()
					))
				})?;
				let after = platform::file_identity(&file)?;
				if after != *identity || u64::try_from(bytes.len()).ok() != Some(identity.size) {
					return Err(identity_changed(relative));
				}
				Ok(bytes)
			},
		}
	}
}

pub fn index_tree(root: &Path) -> IsoResult<PlainTree> {
	let mut entries = BTreeMap::new();
	let Some(root) = platform::open_root(root)? else {
		return Ok(PlainTree { entries, root: None });
	};
	platform::walk_tree(&root, &mut entries)?;
	Ok(PlainTree { entries, root: Some(root) })
}

#[cfg(unix)]
mod platform {
	use std::{
		ffi::{CStr, CString},
		fs::File,
		os::unix::{
			ffi::{OsStrExt as _, OsStringExt as _},
			io::{AsRawFd as _, FromRawFd as _},
		},
		path::{Path, PathBuf},
	};

	use super::{FileIdentity, PlainEntry};
	use crate::{IsoError, IsoResult};

	pub(super) fn walk_tree(
		root: &File,
		entries: &mut std::collections::BTreeMap<PathBuf, PlainEntry>,
	) -> IsoResult<()> {
		walk_directory(root, Path::new(""), entries)
	}

	pub(super) fn file_identity(file: &File) -> IsoResult<FileIdentity> {
		let stat = fstat(file)?;
		identity_from_stat(&stat)
	}

	pub(super) fn open_root(root: &Path) -> IsoResult<Option<File>> {
		let path = CString::new(root.as_os_str().as_bytes())
			.map_err(|_| IsoError::other("plain-diff root contains a NUL byte"))?;
		// SAFETY: `path` is NUL-terminated and the returned descriptor is owned
		// when non-negative.
		let fd = unsafe {
			libc::open(
				path.as_ptr(),
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
			)
		};
		if fd < 0 {
			let err = std::io::Error::last_os_error();
			if err.raw_os_error() == Some(libc::ENOENT) {
				return Ok(None);
			}
			return Err(IsoError::other(format!(
				"open plain-diff root {} without following links: {err}",
				root.display()
			)));
		}
		// SAFETY: `fd` is a newly owned successful `open` result.
		Ok(Some(unsafe { File::from_raw_fd(fd) }))
	}

	pub(super) fn open_regular(root: &File, relative: &Path) -> IsoResult<File> {
		let mut current: Option<File> = None;
		let mut components = relative.components().peekable();
		while let Some(component) = components.next() {
			let std::path::Component::Normal(name) = component else {
				return Err(IsoError::other(format!(
					"invalid plain-diff relative path: {}",
					relative.display()
				)));
			};
			let name = CString::new(name.as_bytes())
				.map_err(|_| IsoError::other("plain-diff path component contains a NUL byte"))?;
			let directory = current.as_ref().unwrap_or(root);
			let final_component = components.peek().is_none();
			let flags = if final_component {
				libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW
			} else {
				libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW
			};
			let next = open_at(directory, &name, flags, relative)?;
			let stat = fstat(&next)?;
			let expected = if final_component {
				libc::S_IFREG
			} else {
				libc::S_IFDIR
			};
			if stat.st_mode & libc::S_IFMT != expected {
				return Err(IsoError::other(format!(
					"plain-diff path changed entry kind: {}",
					relative.display()
				)));
			}
			current = Some(next);
		}
		current.ok_or_else(|| IsoError::other("plain-diff relative path is empty"))
	}

	fn walk_directory(
		directory: &File,
		relative: &Path,
		entries: &mut std::collections::BTreeMap<PathBuf, PlainEntry>,
	) -> IsoResult<()> {
		for name_bytes in directory_names(directory)? {
			let name = CString::new(name_bytes.as_slice())
				.map_err(|_| IsoError::other("plain-diff directory entry contains a NUL byte"))?;
			let display_name = std::ffi::OsString::from_vec(name_bytes);
			let child_relative = relative.join(display_name);
			let named = stat_at(directory, &name, &child_relative)?;
			let kind = named.st_mode & libc::S_IFMT;
			if kind == libc::S_IFDIR {
				let child = open_at(
					directory,
					&name,
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					&child_relative,
				)?;
				let opened = fstat(&child)?;
				if !same_object(&named, &opened) {
					return Err(identity_changed(&child_relative));
				}
				walk_directory(&child, &child_relative, entries)?;
			} else if kind == libc::S_IFLNK {
				let target = read_link_at(directory, &name, &child_relative, &named)?;
				entries.insert(child_relative, PlainEntry::Symlink(target));
			} else if kind == libc::S_IFREG {
				let file = open_at(
					directory,
					&name,
					libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
					&child_relative,
				)?;
				let opened = fstat(&file)?;
				if !same_object(&named, &opened) {
					return Err(identity_changed(&child_relative));
				}
				let identity = identity_from_stat(&opened)?;
				entries.insert(child_relative, PlainEntry::Regular(identity));
			} else {
				return Err(IsoError::other(format!(
					"unsupported special entry in plain diff: {}",
					child_relative.display()
				)));
			}
		}
		Ok(())
	}

	fn directory_names(directory: &File) -> IsoResult<Vec<Vec<u8>>> {
		// SAFETY: `fcntl` duplicates the retained live directory descriptor and
		// returns a separately owned descriptor on success.
		let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
		if duplicate < 0 {
			return Err(IsoError::other(format!(
				"duplicate plain-diff directory handle: {}",
				std::io::Error::last_os_error()
			)));
		}
		// SAFETY: `duplicate` is an owned directory descriptor. `fdopendir`
		// assumes ownership on success.
		let stream = unsafe { libc::fdopendir(duplicate) };
		if stream.is_null() {
			let err = std::io::Error::last_os_error();
			// SAFETY: `fdopendir` failed and therefore did not take ownership.
			unsafe {
				libc::close(duplicate);
			}
			return Err(IsoError::other(format!("open plain-diff directory stream: {err}")));
		}
		let stream = DirectoryStream(stream);
		let mut names = Vec::new();
		loop {
			// SAFETY: `stream` owns a live DIR pointer for this entire loop.
			let entry = unsafe { libc::readdir(stream.0) };
			if entry.is_null() {
				break;
			}
			// SAFETY: POSIX guarantees `d_name` is NUL-terminated for a
			// successfully returned directory entry.
			let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
			if name == b"." || name == b".." {
				continue;
			}
			names.push(name.to_vec());
		}
		Ok(names)
	}

	struct DirectoryStream(*mut libc::DIR);

	impl Drop for DirectoryStream {
		fn drop(&mut self) {
			// SAFETY: this wrapper uniquely owns the successful `fdopendir`
			// result and closes it exactly once.
			unsafe {
				libc::closedir(self.0);
			}
		}
	}

	fn stat_at(directory: &File, name: &CString, relative: &Path) -> IsoResult<libc::stat> {
		// SAFETY: a zeroed `stat` is valid writable storage for `fstatat`.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: the directory descriptor and NUL-terminated name remain live,
		// and `AT_SYMLINK_NOFOLLOW` binds classification to the entry itself.
		if unsafe {
			libc::fstatat(directory.as_raw_fd(), name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW)
		} != 0
		{
			return Err(IsoError::other(format!(
				"inspect plain-diff entry {}: {}",
				relative.display(),
				std::io::Error::last_os_error()
			)));
		}
		Ok(stat)
	}

	fn fstat(file: &File) -> IsoResult<libc::stat> {
		// SAFETY: a zeroed `stat` is valid writable storage for `fstat`.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: `file` retains the descriptor for this synchronous call.
		if unsafe { libc::fstat(file.as_raw_fd(), &mut stat) } != 0 {
			return Err(IsoError::other(format!(
				"inspect retained plain-diff handle: {}",
				std::io::Error::last_os_error()
			)));
		}
		Ok(stat)
	}

	fn open_at(
		directory: &File,
		name: &CString,
		flags: libc::c_int,
		relative: &Path,
	) -> IsoResult<File> {
		// SAFETY: the retained directory and NUL-terminated child name stay
		// live. `O_NOFOLLOW` rejects a replaced final component.
		let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
		if fd < 0 {
			return Err(IsoError::other(format!(
				"open plain-diff entry {} beneath retained directory: {}",
				relative.display(),
				std::io::Error::last_os_error()
			)));
		}
		// SAFETY: `fd` is a newly owned successful `openat` result.
		Ok(unsafe { File::from_raw_fd(fd) })
	}

	fn read_link_at(
		directory: &File,
		name: &CString,
		relative: &Path,
		before: &libc::stat,
	) -> IsoResult<PathBuf> {
		let mut capacity = 256usize;
		let target = loop {
			let mut buffer = vec![0u8; capacity];
			// SAFETY: the retained directory and NUL-terminated name stay live,
			// and `buffer` is writable for its complete length.
			let length = unsafe {
				libc::readlinkat(
					directory.as_raw_fd(),
					name.as_ptr(),
					buffer.as_mut_ptr().cast(),
					buffer.len(),
				)
			};
			if length < 0 {
				return Err(IsoError::other(format!(
					"read plain-diff symlink {}: {}",
					relative.display(),
					std::io::Error::last_os_error()
				)));
			}
			let length = usize::try_from(length)
				.map_err(|_| IsoError::other("plain-diff symlink length overflow"))?;
			if length < buffer.len() {
				buffer.truncate(length);
				break buffer;
			}
			capacity = capacity
				.checked_mul(2)
				.filter(|next| *next <= 64 * 1024)
				.ok_or_else(|| IsoError::other("plain-diff symlink target exceeds 64 KiB"))?;
		};
		let after = stat_at(directory, name, relative)?;
		if !same_exact_entry(before, &after) {
			return Err(identity_changed(relative));
		}
		Ok(PathBuf::from(std::ffi::OsString::from_vec(target)))
	}

	const fn same_object(left: &libc::stat, right: &libc::stat) -> bool {
		left.st_dev == right.st_dev
			&& left.st_ino == right.st_ino
			&& left.st_mode & libc::S_IFMT == right.st_mode & libc::S_IFMT
	}

	fn same_exact_entry(left: &libc::stat, right: &libc::stat) -> bool {
		same_object(left, right)
			&& left.st_size == right.st_size
			&& stat_mtime_ns(left) == stat_mtime_ns(right)
			&& stat_ctime_ns(left) == stat_ctime_ns(right)
	}

	fn identity_from_stat(stat: &libc::stat) -> IsoResult<FileIdentity> {
		Ok(FileIdentity {
			dev:       checked_u64(stat.st_dev, "plain-diff device identity overflow")?,
			ino:       stat.st_ino,
			size:      checked_u64(stat.st_size, "plain-diff file size overflow")?,
			mtime_ns:  stat_mtime_ns(stat),
			change_ns: stat_ctime_ns(stat),
		})
	}

	fn checked_u64<T>(value: T, overflow_message: &'static str) -> IsoResult<u64>
	where
		u64: TryFrom<T>,
	{
		u64::try_from(value).map_err(|_| IsoError::other(overflow_message))
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

	fn identity_changed(relative: &Path) -> IsoError {
		super::identity_changed(relative)
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		path::{Path, PathBuf},
		sync::atomic::{AtomicU64, Ordering},
	};

	use super::{PlainTree, index_tree};

	static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(0);

	struct Fixture {
		root:    PathBuf,
		tree:    PathBuf,
		outside: PathBuf,
	}

	impl Fixture {
		fn new() -> Self {
			let sequence = NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed);
			let root = std::env::temp_dir()
				.join(format!("pi-iso-plain-tree-{}-{sequence}", std::process::id()));
			let tree = root.join("tree");
			let outside = root.join("outside");
			fs::create_dir_all(tree.join("victim")).unwrap();
			fs::create_dir_all(&outside).unwrap();
			Self { root, tree, outside }
		}
	}

	impl Drop for Fixture {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	#[cfg(unix)]
	#[test]
	fn retained_root_handle_rejects_intermediate_symlink_swap_after_indexing() {
		use std::os::unix::fs::symlink;

		let fixture = Fixture::new();
		fs::write(fixture.tree.join("victim/value.txt"), b"inside snapshot").unwrap();
		fs::write(fixture.outside.join("value.txt"), b"outside operator secret").unwrap();
		let index = index_tree(&fixture.tree).unwrap();

		fs::rename(fixture.tree.join("victim"), fixture.tree.join("victim-held")).unwrap();
		symlink(&fixture.outside, fixture.tree.join("victim")).unwrap();

		let error = index
			.read(Path::new("victim/value.txt"))
			.unwrap_err()
			.to_string();
		assert!(error.contains("plain-diff entry"));
		assert!(!error.contains("outside operator secret"));
	}

	#[cfg(windows)]
	fn create_junction(link: &Path, target: &Path) {
		let output = std::process::Command::new("cmd")
			.arg("/C")
			.arg("mklink")
			.arg("/J")
			.arg(link)
			.arg(target)
			.output()
			.unwrap();
		assert!(
			output.status.success(),
			"mklink /J failed: {}",
			String::from_utf8_lossy(&output.stderr)
		);
	}

	#[cfg(windows)]
	fn index_junction_fixture(tree: &Path) -> PlainTree {
		const TRANSIENT_ERROR: &str = "plain-diff entry changed while it was being captured: victim";
		const MAX_ATTEMPTS: usize = 3;

		for attempt in 1..=MAX_ATTEMPTS {
			match index_tree(tree) {
				Ok(index) => return index,
				Err(error) if error.to_string() == TRANSIENT_ERROR && attempt < MAX_ATTEMPTS => {
					std::thread::yield_now();
				},
				Err(error) => panic!("failed to index Windows junction fixture: {error}"),
			}
		}
		unreachable!()
	}

	#[cfg(windows)]
	#[test]
	fn retained_root_handle_rejects_intermediate_junction_swap_after_indexing() {
		let fixture = Fixture::new();
		fs::write(fixture.tree.join("victim/value.txt"), b"inside snapshot").unwrap();
		fs::write(fixture.outside.join("value.txt"), b"outside operator secret").unwrap();
		let index = index_junction_fixture(&fixture.tree);

		fs::rename(fixture.tree.join("victim"), fixture.tree.join("victim-held")).unwrap();
		create_junction(&fixture.tree.join("victim"), &fixture.outside);

		let error = index
			.read(Path::new("victim/value.txt"))
			.unwrap_err()
			.to_string();
		assert!(
			error.contains("plain-diff entry") || error.contains("plain-diff path changed entry kind"),
			"unexpected rejection message: {error}"
		);
		assert!(!error.contains("outside operator secret"));
	}

	#[cfg(windows)]
	#[test]
	fn directory_junction_is_indexed_as_link_data_and_never_traversed() {
		let fixture = Fixture::new();
		fs::remove_dir(fixture.tree.join("victim")).unwrap();
		fs::write(fixture.outside.join("secret.txt"), b"outside operator secret").unwrap();
		create_junction(&fixture.tree.join("victim"), &fixture.outside);

		let index = index_tree(&fixture.tree).unwrap();

		assert!(index.entries.contains_key(Path::new("victim")));
		assert!(!index.entries.contains_key(Path::new("victim/secret.txt")));
		assert!(index.entries.get(Path::new("victim")).unwrap().is_symlink());
	}
}

#[cfg(windows)]
mod platform {
	use std::{
		ffi::{OsStr, OsString},
		fs::File,
		mem::{offset_of, size_of},
		os::windows::{
			ffi::{OsStrExt as _, OsStringExt as _},
			io::{AsRawHandle as _, FromRawHandle as _},
		},
		path::{Path, PathBuf},
		ptr::{null, null_mut},
	};

	use windows_sys::{
		Wdk::{
			Foundation::OBJECT_ATTRIBUTES,
			Storage::FileSystem::{
				FILE_DIRECTORY_FILE, FILE_ID_BOTH_DIR_INFORMATION, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
				FILE_OPEN_REPARSE_POINT, FILE_SYNCHRONOUS_IO_NONALERT, FileIdBothDirectoryInformation,
				NtCreateFile, NtQueryDirectoryFile,
			},
		},
		Win32::{
			Foundation::{
				ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, GetLastError, INVALID_HANDLE_VALUE,
				STATUS_BUFFER_OVERFLOW, STATUS_NO_MORE_FILES, UNICODE_STRING,
			},
			Storage::FileSystem::{
				BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_ATTRIBUTE_DIRECTORY,
				FILE_ATTRIBUTE_NORMAL, FILE_ATTRIBUTE_REPARSE_POINT, FILE_BASIC_INFO,
				FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
				FILE_READ_ATTRIBUTES, FILE_READ_DATA, FILE_SHARE_DELETE, FILE_SHARE_READ,
				FILE_SHARE_WRITE, FILE_TRAVERSE, FileBasicInfo, GetFileInformationByHandle,
				GetFileInformationByHandleEx, MAXIMUM_REPARSE_DATA_BUFFER_SIZE, OPEN_EXISTING,
				SYNCHRONIZE,
			},
			System::{
				IO::{DeviceIoControl, IO_STATUS_BLOCK},
				Ioctl::FSCTL_GET_REPARSE_POINT,
			},
		},
	};

	use super::{FileIdentity, PlainEntry};
	use crate::{IsoError, IsoResult};

	const IO_REPARSE_TAG_MOUNT_POINT: u32 = 0xa000_0003;
	const IO_REPARSE_TAG_SYMLINK: u32 = 0xa000_000c;

	struct HandleInformation {
		legacy: BY_HANDLE_FILE_INFORMATION,
		basic:  FILE_BASIC_INFO,
	}

	struct DirectoryEntry {
		name:            OsString,
		file_id:         u64,
		end_of_file:     u64,
		last_write_time: i64,
		change_time:     i64,
		attributes:      u32,
	}

	pub(super) fn walk_tree(
		root: &File,
		entries: &mut std::collections::BTreeMap<PathBuf, PlainEntry>,
	) -> IsoResult<()> {
		walk_directory(root, Path::new(""), entries)
	}

	pub(super) fn file_identity(file: &File) -> IsoResult<FileIdentity> {
		let information = file_information(file)?;
		if information.basic.FileAttributes
			& (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
			!= 0
		{
			return Err(IsoError::other("retained plain-diff file handle changed entry kind"));
		}
		Ok(identity_from_information(&information))
	}

	pub(super) fn open_root(root: &Path) -> IsoResult<Option<File>> {
		let wide = wide(root.as_os_str());
		// SAFETY: `wide` is NUL-terminated and every pointer is valid for this
		// synchronous call. The successful handle becomes uniquely owned by File.
		let handle = unsafe {
			CreateFileW(
				wide.as_ptr(),
				FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				null(),
				OPEN_EXISTING,
				FILE_ATTRIBUTE_NORMAL | FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
				null_mut(),
			)
		};
		if handle == INVALID_HANDLE_VALUE {
			let error = last_error();
			if matches!(error, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
				return Ok(None);
			}
			return Err(IsoError::other(format!(
				"open plain-diff root {} without following reparse points: Windows error {error}",
				root.display()
			)));
		}
		// SAFETY: `handle` is a newly owned successful CreateFileW result.
		let file = unsafe { File::from_raw_handle(handle) };
		let information = file_information(&file)?;
		if information.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0
			|| information.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
		{
			return Err(IsoError::other(format!(
				"plain-diff root is not a non-reparse directory: {}",
				root.display()
			)));
		}
		Ok(Some(file))
	}

	pub(super) fn open_regular(root: &File, relative: &Path) -> IsoResult<File> {
		let mut current: Option<File> = None;
		let mut components = relative.components().peekable();
		while let Some(component) = components.next() {
			let std::path::Component::Normal(name) = component else {
				return Err(IsoError::other(format!(
					"invalid plain-diff relative path: {}",
					relative.display()
				)));
			};
			let directory = current.as_ref().unwrap_or(root);
			let final_component = components.peek().is_none();
			let next = open_relative(
				directory,
				name,
				if final_component {
					FILE_READ_ATTRIBUTES | FILE_READ_DATA
				} else {
					FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE
				},
				!final_component,
			)
			.map_err(|code| {
				IsoError::other(format!(
					"open plain-diff entry {} beneath retained directory: {code}",
					relative.display()
				))
			})?;
			let information = file_information(&next)?;
			let is_directory = information.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0;
			let is_reparse = information.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0;
			if is_reparse || is_directory != !final_component {
				return Err(IsoError::other(format!(
					"plain-diff path changed entry kind: {}",
					relative.display()
				)));
			}
			current = Some(next);
		}
		current.ok_or_else(|| IsoError::other("plain-diff relative path is empty"))
	}

	fn walk_directory(
		directory: &File,
		relative: &Path,
		entries: &mut std::collections::BTreeMap<PathBuf, PlainEntry>,
	) -> IsoResult<()> {
		let mut names = directory_names(directory)?;
		names.sort_by(|left, right| left.name.cmp(&right.name));
		for named in names {
			let child_relative = relative.join(&named.name);
			let child = open_child(directory, &named.name, &child_relative)?;
			let information = file_information(&child)?;
			if !named.matches(&information) {
				return Err(super::identity_changed(&child_relative));
			}
			if information.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				let target = reparse_target(&child, &child_relative)?;
				let after = file_information(&child)?;
				if !same_information(&information, &after) {
					return Err(super::identity_changed(&child_relative));
				}
				entries.insert(child_relative, PlainEntry::Symlink(target));
			} else if information.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
				walk_directory(&child, &child_relative, entries)?;
			} else {
				let identity = identity_from_information(&information);
				entries.insert(child_relative, PlainEntry::Regular(identity));
			}
		}
		Ok(())
	}

	fn open_child(parent: &File, name: &OsStr, relative: &Path) -> IsoResult<File> {
		open_relative(parent, name, FILE_READ_ATTRIBUTES | FILE_READ_DATA, false)
			.or_else(|_| {
				open_relative(
					parent,
					name,
					FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_TRAVERSE,
					true,
				)
			})
			.map_err(|code| {
				IsoError::other(format!(
					"open plain-diff entry {} beneath retained directory: {code}",
					relative.display()
				))
			})
	}

	fn open_relative(
		parent: &File,
		name: &OsStr,
		desired_access: u32,
		directory: bool,
	) -> Result<File, &'static str> {
		let mut name: Vec<u16> = name.encode_wide().collect();
		if name.is_empty()
			|| name.contains(&0)
			|| name.len() > usize::from(u16::MAX) / size_of::<u16>()
		{
			return Err("invalid child name");
		}
		let byte_length =
			u16::try_from(name.len() * size_of::<u16>()).map_err(|_| "child name too long")?;
		let object_name = UNICODE_STRING {
			Length:        byte_length,
			MaximumLength: byte_length,
			Buffer:        name.as_mut_ptr(),
		};
		let attributes = OBJECT_ATTRIBUTES {
			Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
			RootDirectory:            parent.as_raw_handle(),
			ObjectName:               &raw const object_name,
			Attributes:               0,
			SecurityDescriptor:       null(),
			SecurityQualityOfService: null(),
		};
		// SAFETY: zero is the defined initial state for this NT output block.
		let mut status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
		let mut handle = INVALID_HANDLE_VALUE;
		let options = FILE_OPEN_REPARSE_POINT
			| FILE_SYNCHRONOUS_IO_NONALERT
			| if directory {
				FILE_DIRECTORY_FILE
			} else {
				FILE_NON_DIRECTORY_FILE
			};
		// SAFETY: the retained parent handle, UTF-16 name, object attributes and
		// status block all remain live for this synchronous call.
		let result = unsafe {
			NtCreateFile(
				&mut handle,
				desired_access | SYNCHRONIZE,
				&raw const attributes,
				&mut status,
				null(),
				FILE_ATTRIBUTE_NORMAL,
				FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
				FILE_OPEN,
				options,
				null(),
				0,
			)
		};
		if result < 0 {
			return Err(ntstatus_code(result));
		}
		// SAFETY: `handle` is a newly owned successful NtCreateFile result.
		Ok(unsafe { File::from_raw_handle(handle) })
	}

	fn directory_names(directory: &File) -> IsoResult<Vec<DirectoryEntry>> {
		let mut names = Vec::new();
		let mut restart_scan = true;
		loop {
			let mut buffer = vec![0u8; 64 * 1024];
			// SAFETY: zero is the defined initial state for this NT output block.
			let mut status: IO_STATUS_BLOCK = unsafe { std::mem::zeroed() };
			// SAFETY: the retained directory handle and writable output buffer
			// remain live for this synchronous query.
			let result = unsafe {
				NtQueryDirectoryFile(
					directory.as_raw_handle(),
					null_mut(),
					None,
					null(),
					&mut status,
					buffer.as_mut_ptr().cast(),
					buffer.len() as u32,
					FileIdBothDirectoryInformation,
					false,
					null(),
					restart_scan,
				)
			};
			restart_scan = false;
			if result == STATUS_NO_MORE_FILES {
				return Ok(names);
			}
			if result < 0 && result != STATUS_BUFFER_OVERFLOW {
				return Err(IsoError::other(format!(
					"enumerate retained plain-diff directory: {}",
					ntstatus_code(result)
				)));
			}
			if status.Information > buffer.len() {
				return Err(IsoError::other(
					"plain-diff directory query returned an invalid byte count",
				));
			}
			let used = status.Information;
			if used == 0 {
				return if result == 0 {
					Ok(names)
				} else {
					Err(IsoError::other("empty failed plain-diff directory query"))
				};
			}
			let minimum = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileName);
			let last_write_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, LastWriteTime);
			let change_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, ChangeTime);
			let end_of_file_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, EndOfFile);
			let attributes_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileAttributes);
			let file_id_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileId);
			let name_length_offset = offset_of!(FILE_ID_BOTH_DIR_INFORMATION, FileNameLength);
			let mut offset = 0usize;
			while offset < used {
				let available = used
					.checked_sub(offset)
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				if available < minimum {
					return Err(IsoError::other("truncated plain-diff directory record"));
				}
				let next_end = offset
					.checked_add(size_of::<u32>())
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				let next = u32::from_le_bytes(
					buffer[offset..next_end]
						.try_into()
						.map_err(|_| IsoError::other("invalid plain-diff directory record"))?,
				) as usize;
				let record_size = if next == 0 {
					available
				} else if next >= minimum && next <= available {
					next
				} else {
					return Err(IsoError::other("invalid plain-diff directory record offset"));
				};
				let length_start = offset
					.checked_add(name_length_offset)
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				let length_end = length_start
					.checked_add(size_of::<u32>())
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				let length = u32::from_le_bytes(
					buffer
						.get(length_start..length_end)
						.ok_or_else(|| IsoError::other("truncated plain-diff directory name"))?
						.try_into()
						.map_err(|_| IsoError::other("invalid plain-diff directory name"))?,
				) as usize;
				if !length.is_multiple_of(size_of::<u16>()) || length > record_size - minimum {
					return Err(IsoError::other("invalid UTF-16 length in plain-diff directory record"));
				}
				let name_start = offset
					.checked_add(minimum)
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				let name_end = name_start
					.checked_add(length)
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
				let units = buffer
					.get(name_start..name_end)
					.ok_or_else(|| IsoError::other("truncated plain-diff directory name"))?
					.chunks_exact(size_of::<u16>())
					.map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
					.collect::<Vec<_>>();
				if units.as_slice() != [b'.'.into()] && units.as_slice() != [b'.'.into(), b'.'.into()] {
					let end_of_file = record_i64(&buffer, offset, end_of_file_offset)?;
					names.push(DirectoryEntry {
						name:            OsString::from_wide(&units),
						file_id:         record_i64(&buffer, offset, file_id_offset)? as u64,
						end_of_file:     u64::try_from(end_of_file)
							.map_err(|_| IsoError::other("negative plain-diff directory entry size"))?,
						last_write_time: record_i64(&buffer, offset, last_write_offset)?,
						change_time:     record_i64(&buffer, offset, change_offset)?,
						attributes:      record_u32(&buffer, offset, attributes_offset)?,
					});
				}
				if next == 0 {
					break;
				}
				offset = offset
					.checked_add(next)
					.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
			}
		}
	}

	fn record_u32(buffer: &[u8], record: usize, field: usize) -> IsoResult<u32> {
		let start = record
			.checked_add(field)
			.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
		let end = start
			.checked_add(size_of::<u32>())
			.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
		Ok(u32::from_le_bytes(
			buffer
				.get(start..end)
				.ok_or_else(|| IsoError::other("truncated plain-diff directory record"))?
				.try_into()
				.map_err(|_| IsoError::other("invalid plain-diff directory record"))?,
		))
	}

	fn record_i64(buffer: &[u8], record: usize, field: usize) -> IsoResult<i64> {
		let start = record
			.checked_add(field)
			.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
		let end = start
			.checked_add(size_of::<i64>())
			.ok_or_else(|| IsoError::other("plain-diff directory record overflow"))?;
		Ok(i64::from_le_bytes(
			buffer
				.get(start..end)
				.ok_or_else(|| IsoError::other("truncated plain-diff directory record"))?
				.try_into()
				.map_err(|_| IsoError::other("invalid plain-diff directory record"))?,
		))
	}

	fn reparse_target(file: &File, relative: &Path) -> IsoResult<PathBuf> {
		let mut buffer = vec![0u8; MAXIMUM_REPARSE_DATA_BUFFER_SIZE as usize];
		let mut returned = 0u32;
		// SAFETY: the retained reparse-point handle and complete writable output
		// buffer remain live for this synchronous call.
		if unsafe {
			DeviceIoControl(
				file.as_raw_handle(),
				FSCTL_GET_REPARSE_POINT,
				null(),
				0,
				buffer.as_mut_ptr().cast(),
				buffer.len() as u32,
				&mut returned,
				null_mut(),
			)
		} == 0
		{
			return Err(IsoError::other(format!(
				"read retained reparse point {}: Windows error {}",
				relative.display(),
				last_error()
			)));
		}
		let used = usize::try_from(returned)
			.map_err(|_| IsoError::other("plain-diff reparse buffer length overflow"))?;
		if used < 8 || used > buffer.len() {
			return Err(IsoError::other("invalid plain-diff reparse buffer"));
		}
		let tag = u32::from_le_bytes(
			buffer[0..4]
				.try_into()
				.map_err(|_| IsoError::other("invalid plain-diff reparse tag"))?,
		);
		let data_length = usize::from(u16::from_le_bytes(
			buffer[4..6]
				.try_into()
				.map_err(|_| IsoError::other("invalid plain-diff reparse length"))?,
		));
		if 8usize
			.checked_add(data_length)
			.as_ref()
			.is_none_or(|end| *end > used)
		{
			return Err(IsoError::other("truncated plain-diff reparse buffer"));
		}
		match tag {
			IO_REPARSE_TAG_SYMLINK => decode_reparse_name(&buffer[..used], 20),
			IO_REPARSE_TAG_MOUNT_POINT => decode_reparse_name(&buffer[..used], 16),
			_ => Err(IsoError::other(format!(
				"unsupported reparse point in plain diff: {}",
				relative.display()
			))),
		}
	}

	fn decode_reparse_name(buffer: &[u8], path_buffer_offset: usize) -> IsoResult<PathBuf> {
		if buffer.len() < path_buffer_offset {
			return Err(IsoError::other("truncated plain-diff reparse name"));
		}
		let field = |offset: usize| -> IsoResult<usize> {
			let end = offset
				.checked_add(size_of::<u16>())
				.ok_or_else(|| IsoError::other("plain-diff reparse field overflow"))?;
			Ok(usize::from(u16::from_le_bytes(
				buffer
					.get(offset..end)
					.ok_or_else(|| IsoError::other("truncated plain-diff reparse field"))?
					.try_into()
					.map_err(|_| IsoError::other("invalid plain-diff reparse field"))?,
			)))
		};
		let substitute_offset = field(8)?;
		let substitute_length = field(10)?;
		let print_offset = field(12)?;
		let print_length = field(14)?;
		let (offset, length) = if print_length == 0 {
			(substitute_offset, substitute_length)
		} else {
			(print_offset, print_length)
		};
		if offset % size_of::<u16>() != 0 || length % size_of::<u16>() != 0 {
			return Err(IsoError::other("misaligned plain-diff reparse name"));
		}
		let start = path_buffer_offset
			.checked_add(offset)
			.ok_or_else(|| IsoError::other("plain-diff reparse name overflow"))?;
		let end = start
			.checked_add(length)
			.ok_or_else(|| IsoError::other("plain-diff reparse name overflow"))?;
		let units = buffer
			.get(start..end)
			.ok_or_else(|| IsoError::other("truncated plain-diff reparse name"))?
			.chunks_exact(size_of::<u16>())
			.map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
			.collect::<Vec<_>>();
		Ok(PathBuf::from(OsString::from_wide(&units)))
	}

	fn file_information(file: &File) -> IsoResult<HandleInformation> {
		// SAFETY: zero is a valid initial representation for this Win32 output
		// structure.
		let mut legacy: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
		// SAFETY: `file` retains its handle and `legacy` is writable.
		if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut legacy) } == 0 {
			return Err(IsoError::other(format!(
				"inspect retained plain-diff handle: Windows error {}",
				last_error()
			)));
		}
		// SAFETY: zero is a valid initial representation for this Win32 output
		// structure.
		let mut basic: FILE_BASIC_INFO = unsafe { std::mem::zeroed() };
		let basic_size = u32::try_from(size_of::<FILE_BASIC_INFO>())
			.map_err(|_| IsoError::other("plain-diff file information size overflow"))?;
		// SAFETY: `file` retains its handle and `basic` is writable for its
		// complete declared size.
		if unsafe {
			GetFileInformationByHandleEx(
				file.as_raw_handle(),
				FileBasicInfo,
				(&raw mut basic).cast(),
				basic_size,
			)
		} == 0
		{
			return Err(IsoError::other(format!(
				"inspect retained plain-diff change time: Windows error {}",
				last_error()
			)));
		}
		Ok(HandleInformation { legacy, basic })
	}

	fn identity_from_information(information: &HandleInformation) -> FileIdentity {
		let ino = (u64::from(information.legacy.nFileIndexHigh) << 32)
			| u64::from(information.legacy.nFileIndexLow);
		let size = (u64::from(information.legacy.nFileSizeHigh) << 32)
			| u64::from(information.legacy.nFileSizeLow);
		FileIdentity {
			dev: u64::from(information.legacy.dwVolumeSerialNumber),
			ino,
			size,
			mtime_ns: i128::from(information.basic.LastWriteTime) * 100,
			change_ns: i128::from(information.basic.ChangeTime) * 100,
		}
	}

	impl DirectoryEntry {
		fn matches(&self, information: &HandleInformation) -> bool {
			let identity = identity_from_information(information);
			let kind_mask = FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT;
			if self.file_id != identity.ino
				|| self.attributes & kind_mask != information.basic.FileAttributes & kind_mask
			{
				return false;
			}
			let is_plain_directory = information.basic.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
				&& information.basic.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0;
			if is_plain_directory {
				// NTFS updates a directory's parent-index metadata lazily, so the
				// size/timestamps seen by enumeration can trail the open handle
				// while contents were just written. The 64-bit file id plus the
				// kind bits are the stable identity for plain directories.
				return true;
			}
			self.end_of_file == identity.size
				&& self.last_write_time == information.basic.LastWriteTime
				&& self.change_time == information.basic.ChangeTime
		}
	}

	fn same_information(left: &HandleInformation, right: &HandleInformation) -> bool {
		identity_from_information(left) == identity_from_information(right)
			&& left.basic.FileAttributes == right.basic.FileAttributes
	}

	fn wide(value: &OsStr) -> Vec<u16> {
		value.encode_wide().chain(Some(0)).collect()
	}

	fn last_error() -> u32 {
		// SAFETY: GetLastError reads the calling thread's error slot and has no
		// pointer or lifetime preconditions.
		unsafe { GetLastError() }
	}

	const fn ntstatus_code(status: i32) -> &'static str {
		match status as u32 {
			0xc000_0034 | 0xc000_003a => "not found",
			0xc000_0022 => "access denied",
			0xc000_050b => "reparse point rejected",
			_ => "Windows NT I/O error",
		}
	}
}

#[cfg(not(any(unix, windows)))]
mod platform {
	use std::{
		fs::File,
		path::{Path, PathBuf},
	};

	use super::{FileIdentity, PlainEntry};
	use crate::{IsoError, IsoResult};

	pub(super) fn open_root(_root: &Path) -> IsoResult<Option<File>> {
		Err(IsoError::unavailable("secure plain-diff traversal is unavailable on this platform"))
	}

	pub(super) fn walk_tree(
		_root: &File,
		_entries: &mut std::collections::BTreeMap<PathBuf, PlainEntry>,
	) -> IsoResult<()> {
		Err(IsoError::unavailable("secure plain-diff traversal is unavailable on this platform"))
	}

	pub(super) fn open_regular(_root: &File, _relative: &Path) -> IsoResult<File> {
		Err(IsoError::unavailable("secure plain-diff traversal is unavailable on this platform"))
	}

	pub(super) fn file_identity(_file: &File) -> IsoResult<FileIdentity> {
		Err(IsoError::unavailable("secure plain-diff traversal is unavailable on this platform"))
	}
}
