//! Descriptor-retained, bounded doctor journal authority.
#[cfg(unix)]
use std::{
	ffi::CString,
	fs::{File, Metadata},
	io::{Read, Seek, SeekFrom, Write},
	os::{
		fd::{AsRawFd, FromRawFd},
		unix::fs::MetadataExt,
	},
	path::{Path, PathBuf},
};

use napi_derive::napi;

const MAX_BYTES: usize = 128 * 1024;

#[napi(object, object_from_js = false)]
pub struct DoctorJournalCreateResult {
	pub authority:           Option<DoctorJournalAuthority>,
	pub side_effect_started: bool,
	pub reason_code:         Option<String>,
}

#[cfg(unix)]
fn io_code(error: std::io::Error) -> String {
	match error.kind() {
		std::io::ErrorKind::NotFound => "not_found",
		std::io::ErrorKind::PermissionDenied => "permission_denied",
		std::io::ErrorKind::AlreadyExists => "already_exists",
		_ => "journal_io_error",
	}
	.to_owned()
}

#[cfg(unix)]
fn name(value: &str) -> Result<CString, String> {
	if value.is_empty() || value == "." || value == ".." || value.contains('/') {
		return Err("invalid_journal_name".to_owned());
	}
	CString::new(value).map_err(|_| "invalid_journal_name".to_owned())
}

#[cfg(unix)]
fn same_object(a: &Metadata, b: &Metadata) -> bool {
	a.dev() == b.dev()
		&& a.ino() == b.ino()
		&& a.mode() == b.mode()
		&& a.uid() == b.uid()
		&& a.gid() == b.gid()
		&& ((a.is_dir() && b.is_dir()) || a.nlink() == b.nlink())
}

#[cfg(unix)]
fn directory_security(file: &File, private: bool, ancestor: bool) -> Result<Metadata, String> {
	let meta = file.metadata().map_err(io_code)?;
	// SAFETY: geteuid has no arguments or side effects.
	let uid = unsafe { libc::geteuid() };
	let sticky_root = ancestor && meta.uid() == 0 && meta.mode() & 0o1000 != 0;
	if !meta.is_dir()
		|| meta.nlink() == 0
		|| (meta.uid() != uid && !(ancestor && meta.uid() == 0))
		|| (private && meta.mode() & 0o777 != 0o700)
		|| (!private && meta.mode() & 0o022 != 0 && !sticky_root)
	{
		return Err("unsafe_journal_directory".to_owned());
	}
	crate::path_identity::verify_descriptor_acl_absent(file, true)?;
	Ok(meta)
}

#[cfg(unix)]
fn file_security(file: &File) -> Result<Metadata, String> {
	let meta = file.metadata().map_err(io_code)?;
	// SAFETY: geteuid only observes process credentials.
	if !meta.is_file()
		|| meta.nlink() != 1
		|| meta.mode() & 0o777 != 0o600
		|| meta.uid() != unsafe { libc::geteuid() }
	{
		return Err("unsafe_journal_file".to_owned());
	}
	crate::path_identity::verify_descriptor_acl_absent(file, false)?;
	Ok(meta)
}

#[cfg(unix)]
fn open_directory(
	parent: &File,
	component: &str,
	create: bool,
	exclusive: bool,
	private: bool,
	started: &mut bool,
) -> Result<File, String> {
	let component = name(component)?;
	if create {
		// SAFETY: parent is live and component is a single NUL-terminated name.
		let result = unsafe { libc::mkdirat(parent.as_raw_fd(), component.as_ptr(), 0o700) };
		if result == 0 {
			*started = true;
			parent.sync_all().map_err(io_code)?;
		} else {
			let error = std::io::Error::last_os_error();
			if exclusive || error.kind() != std::io::ErrorKind::AlreadyExists {
				return Err(io_code(error));
			}
		}
	}
	// SAFETY: parent is retained; no-follow and directory flags reject
	// substitutions.
	let fd = unsafe {
		libc::openat(
			parent.as_raw_fd(),
			component.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
		)
	};
	if fd < 0 {
		return Err(io_code(std::io::Error::last_os_error()));
	}
	// SAFETY: openat returned a new owned descriptor.
	let file = unsafe { File::from_raw_fd(fd) };
	directory_security(&file, private, false)?;
	Ok(file)
}

#[cfg(unix)]
fn check_edge(
	parent: &File,
	component: &str,
	expected: &File,
	directory: bool,
) -> Result<(), String> {
	let component = name(component)?;
	let flags = libc::O_RDONLY
		| libc::O_NOFOLLOW
		| libc::O_NONBLOCK
		| libc::O_CLOEXEC
		| if directory { libc::O_DIRECTORY } else { 0 };
	// SAFETY: both arguments are retained owned objects and the name is bounded.
	let fd = unsafe { libc::openat(parent.as_raw_fd(), component.as_ptr(), flags) };
	if fd < 0 {
		return Err(io_code(std::io::Error::last_os_error()));
	}
	// SAFETY: fd is a newly opened descriptor.
	let named = unsafe { File::from_raw_fd(fd) };
	if !same_object(&expected.metadata().map_err(io_code)?, &named.metadata().map_err(io_code)?) {
		return Err("journal_identity_changed".to_owned());
	}
	Ok(())
}

#[cfg(unix)]
struct JournalState {
	root_path:        PathBuf,
	root_parent_path: PathBuf,
	root_name:        String,
	root_parent:      File,
	root:             File,
	doctor:           File,
	repairs:          File,
	run:              File,
	file:             File,
	run_id:           String,
	contents:         Vec<u8>,
}

#[cfg(unix)]
impl JournalState {
	fn verify(&self) -> Result<(), String> {
		let parent = directory_security(&self.root_parent, false, true)?;
		let named_parent = std::fs::symlink_metadata(&self.root_parent_path).map_err(io_code)?;
		if named_parent.file_type().is_symlink() || !same_object(&parent, &named_parent) {
			return Err("journal_parent_changed".to_owned());
		}
		let root = directory_security(&self.root, false, false)?;
		let named_root = std::fs::symlink_metadata(&self.root_path).map_err(io_code)?;
		if named_root.file_type().is_symlink() || !same_object(&root, &named_root) {
			return Err("journal_root_changed".to_owned());
		}
		for directory in [&self.doctor, &self.repairs, &self.run] {
			directory_security(directory, true, false)?;
		}
		let meta = file_security(&self.file)?;
		check_edge(&self.root_parent, &self.root_name, &self.root, true)?;
		check_edge(&self.root, "doctor", &self.doctor, true)?;
		check_edge(&self.doctor, "repairs", &self.repairs, true)?;
		check_edge(&self.repairs, &self.run_id, &self.run, true)?;
		check_edge(&self.run, "journal.ndjson", &self.file, false)?;
		if meta.len() != self.contents.len() as u64 || meta.len() > MAX_BYTES as u64 {
			return Err("journal_content_changed".to_owned());
		}
		let mut reader = self.file.try_clone().map_err(io_code)?;
		reader.seek(SeekFrom::Start(0)).map_err(io_code)?;
		let mut observed = vec![0; self.contents.len()];
		reader.read_exact(&mut observed).map_err(io_code)?;
		let mut extra = [0];
		if observed != self.contents || reader.read(&mut extra).map_err(io_code)? != 0 {
			return Err("journal_content_changed".to_owned());
		}
		Ok(())
	}

	fn create(root_path: &Path, run_id: String, started: &mut bool) -> Result<Self, String> {
		if !root_path.is_absolute() {
			return Err("invalid_journal_root".to_owned());
		}
		let root_name = root_path
			.file_name()
			.and_then(|value| value.to_str())
			.ok_or_else(|| "invalid_journal_root".to_owned())?
			.to_owned();
		let parent_path = root_path
			.parent()
			.ok_or_else(|| "invalid_journal_root".to_owned())?;
		let root_parent_path = std::fs::canonicalize(parent_path).map_err(io_code)?;
		let parent_name = CString::new(root_parent_path.as_os_str().as_encoded_bytes())
			.map_err(|_| "invalid_journal_root".to_owned())?;
		// SAFETY: parent_name is a live NUL-terminated canonical path.
		let fd = unsafe {
			libc::open(
				parent_name.as_ptr(),
				libc::O_RDONLY
					| libc::O_DIRECTORY
					| libc::O_NOFOLLOW
					| libc::O_NONBLOCK
					| libc::O_CLOEXEC,
			)
		};
		if fd < 0 {
			return Err(io_code(std::io::Error::last_os_error()));
		}
		// SAFETY: fd is a new owned directory descriptor.
		let root_parent = unsafe { File::from_raw_fd(fd) };
		directory_security(&root_parent, false, true)?;
		let root = open_directory(&root_parent, &root_name, true, false, false, started)?;
		let doctor = open_directory(&root, "doctor", true, false, true, started)?;
		let repairs = open_directory(&doctor, "repairs", true, false, true, started)?;
		let run = open_directory(&repairs, &run_id, true, true, true, started)?;
		// SAFETY: run is retained; this fixed filename is NUL-terminated and exclusive.
		let fd = unsafe {
			libc::openat(
				run.as_raw_fd(),
				c"journal.ndjson".as_ptr(),
				libc::O_RDWR
					| libc::O_APPEND
					| libc::O_CREAT
					| libc::O_EXCL
					| libc::O_NOFOLLOW
					| libc::O_NONBLOCK
					| libc::O_CLOEXEC,
				0o600,
			)
		};
		if fd < 0 {
			return Err(io_code(std::io::Error::last_os_error()));
		}
		*started = true;
		// SAFETY: fd is a new owned regular file descriptor.
		let file = unsafe { File::from_raw_fd(fd) };
		file_security(&file)?;
		for file in [&file, &run, &repairs, &doctor, &root, &root_parent] {
			file.sync_all().map_err(io_code)?;
		}
		let state = Self {
			root_path: root_path.to_owned(),
			root_parent_path,
			root_name,
			root_parent,
			root,
			doctor,
			repairs,
			run,
			file,
			run_id,
			contents: Vec::new(),
		};
		state.verify()?;
		Ok(state)
	}
}

#[napi]
pub struct DoctorJournalAuthority {
	#[cfg(unix)]
	state: Option<JournalState>,
}

#[napi]
impl DoctorJournalAuthority {
	#[napi]
	pub fn create_exact(root: String, run_id: String) -> DoctorJournalCreateResult {
		let valid = !run_id.is_empty()
			&& run_id.len() <= 64
			&& run_id.as_bytes()[0].is_ascii_alphanumeric()
			&& run_id
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
		if !valid {
			return DoctorJournalCreateResult {
				authority:           None,
				side_effect_started: false,
				reason_code:         Some("invalid_run_id".to_owned()),
			};
		}
		#[cfg(unix)]
		{
			let mut started = false;
			match JournalState::create(Path::new(&root), run_id, &mut started) {
				Ok(state) => DoctorJournalCreateResult {
					authority:           Some(Self { state: Some(state) }),
					side_effect_started: started,
					reason_code:         None,
				},
				Err(code) => DoctorJournalCreateResult {
					authority:           None,
					side_effect_started: started,
					reason_code:         Some(code),
				},
			}
		}
		#[cfg(not(unix))]
		{
			let _ = (root, run_id);
			DoctorJournalCreateResult {
				authority:           None,
				side_effect_started: false,
				reason_code:         Some("unsupported_platform".to_owned()),
			}
		}
	}

	#[napi]
	pub fn append(&mut self, record: String) -> napi::Result<()> {
		if record.is_empty() || record.contains(['\n', '\r']) || record.len() + 1 > MAX_BYTES {
			return Err(napi::Error::from_reason("invalid_journal_record"));
		}
		#[cfg(unix)]
		{
			let state = self
				.state
				.as_mut()
				.ok_or_else(|| napi::Error::from_reason("journal_closed"))?;
			state.verify().map_err(napi::Error::from_reason)?;
			if state.contents.len().saturating_add(record.len() + 1) > MAX_BYTES {
				return Err(napi::Error::from_reason("journal_size_limit"));
			}
			let mut line = record.into_bytes();
			line.push(b'\n');
			state
				.file
				.write_all(&line)
				.and_then(|()| state.file.sync_all())
				.map_err(|error| napi::Error::from_reason(io_code(error)))?;
			state.contents.extend_from_slice(&line);
			state
				.run
				.sync_all()
				.map_err(|error| napi::Error::from_reason(io_code(error)))?;
			state.verify().map_err(napi::Error::from_reason)
		}
		#[cfg(not(unix))]
		Err(napi::Error::from_reason("unsupported_platform"))
	}

	#[napi]
	pub fn close(&mut self) {
		#[cfg(unix)]
		{
			self.state.take();
		}
	}
}
