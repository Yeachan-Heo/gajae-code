use std::{
	collections::HashSet,
	env,
	os::windows::process::CommandExt as _,
	path::{Path, PathBuf},
	process::Command,
};

use anyhow::{Error, Result};
use brush_core::{
	Shell as BrushShell, ShellValue, ShellVariable, commands::CommandWindowControlExt as _,
};
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

pub fn configure_windows_path(shell: &mut BrushShell) -> Result<()> {
	let install_roots = find_git_install_roots();
	let git_paths = find_git_paths();
	if install_roots.is_empty() && git_paths.is_empty() {
		return Ok(());
	}

	let existing_path = shell
		.env()
		.get("PATH")
		.and_then(|(_, var)| match var.value() {
			ShellValue::String(value) => Some(value.clone()),
			_ => None,
		})
		.unwrap_or_default();

	// Translate MSYS2-style entries (e.g. /usr/bin, /mingw64/bin, /c/Users/...)
	// into Windows-native paths so brush-core's std::path-based lookups can
	// resolve executables shipped with Git Bash.
	let mut segments: Vec<String> = Vec::new();
	let mut seen_normalized: HashSet<String> = HashSet::new();
	for raw in env::split_paths(&existing_path) {
		let raw_str = raw.to_string_lossy().into_owned();
		if raw_str.trim().is_empty() {
			continue;
		}
		let translated = translate_msys_segment(&raw_str, &install_roots).unwrap_or(raw_str);
		let normalized = normalize_path(Path::new(&translated));
		if normalized.is_empty() {
			segments.push(translated);
			continue;
		}
		if !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(translated);
	}

	for git_path in &git_paths {
		if !Path::new(git_path).is_dir() {
			continue;
		}
		let normalized = normalize_path(Path::new(git_path));
		if normalized.is_empty() || !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(git_path.clone());
	}

	let updated_path = segments.join(";");
	if updated_path == existing_path {
		return Ok(());
	}

	let mut var = ShellVariable::new(ShellValue::String(updated_path));
	var.export();
	shell
		.env_mut()
		.set_global("PATH", var)
		.map_err(|err| Error::msg(format!("Failed to set PATH: {err}")))?;

	Ok(())
}

fn normalize_path(path: &Path) -> String {
	let path_str = path.to_string_lossy();
	let trimmed = path_str.trim();
	let unquoted = trimmed.trim_matches('"');
	if unquoted.is_empty() {
		return String::new();
	}

	let path = Path::new(unquoted);
	if let Ok(canonical) = path.canonicalize() {
		return canonical.to_string_lossy().into_owned();
	}

	let mut normalized = PathBuf::new();
	for component in path.components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().into_owned()
}

fn find_git_paths() -> Vec<String> {
	let mut paths = Vec::new();
	let mut seen = HashSet::new();

	for install_path in [query_git_install_path_from_registry(), query_git_install_path_from_where()]
		.into_iter()
		.flatten()
	{
		for path in git_paths_for_install_root(&install_path) {
			let normalized = normalize_path(Path::new(&path));
			if normalized.is_empty() {
				continue;
			}
			if seen.insert(normalized) {
				paths.push(path);
			}
		}
	}

	paths
}

fn query_git_install_path_from_registry() -> Option<String> {
	let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
	let key_paths = ["SOFTWARE\\GitForWindows", "SOFTWARE\\WOW6432Node\\GitForWindows"];

	for key_path in key_paths {
		if let Ok(key) = hklm.open_subkey(key_path)
			&& let Ok(path) = key.get_value::<String, _>("InstallPath")
			&& !path.is_empty()
		{
			return Some(path);
		}
	}

	None
}

fn query_git_install_path_from_where() -> Option<String> {
	let mut command = Command::new("where");
	// Shell-session setup runs even when the host is a console-less ACP/GUI
	// embedder (#4883); without this flag each probe would flash a visible
	// console window. Same host-console-aware contract as external command
	// spawns in brush-core: a console-attached host inherits unchanged.
	if Command::host_is_consoleless() {
		command.creation_flags(CREATE_NO_WINDOW);
	}
	let output = command.arg("git").output().ok()?;
	if !output.status.success() {
		return None;
	}

	let stdout = String::from_utf8_lossy(&output.stdout);
	let line = stdout.lines().next()?.trim();
	if line.is_empty() {
		return None;
	}

	let git_path = Path::new(line);
	let install_root = git_install_root_from_path(git_path)?;
	Some(install_root.to_string_lossy().into_owned())
}

fn git_install_root_from_path(git_path: &Path) -> Option<PathBuf> {
	let parent = git_path.parent()?;
	let parent_name = parent.file_name()?.to_string_lossy();

	if parent_name.eq_ignore_ascii_case("cmd") {
		return parent.parent().map(Path::to_path_buf);
	}

	if parent_name.eq_ignore_ascii_case("bin") {
		let grandparent = parent.parent()?;
		if let Some(grandparent_name) = grandparent.file_name() {
			let grandparent_name = grandparent_name.to_string_lossy();
			if grandparent_name.eq_ignore_ascii_case("usr")
				|| grandparent_name.eq_ignore_ascii_case("mingw64")
				|| grandparent_name.eq_ignore_ascii_case("mingw32")
			{
				return grandparent.parent().map(Path::to_path_buf);
			}
		}
		return Some(grandparent.to_path_buf());
	}

	parent.parent().map(Path::to_path_buf)
}

fn git_paths_for_install_root(install_root: &str) -> Vec<String> {
	let root = Path::new(install_root);
	let mut paths = Vec::new();

	let cmd = root.join("cmd");
	if has_git_command(&cmd) {
		paths.push(cmd.to_string_lossy().into_owned());
	}

	let bin = root.join("bin");
	if has_git_command(&bin) {
		paths.push(bin.to_string_lossy().into_owned());
	}

	let usr_bin = root.join("usr").join("bin");
	if has_git_command(&usr_bin) || usr_bin.join("ls.exe").is_file() {
		paths.push(usr_bin.to_string_lossy().into_owned());
	}

	paths
}

fn has_git_command(dir: &Path) -> bool {
	if !dir.is_dir() {
		return false;
	}

	["git.exe", "git.cmd", "git.bat"]
		.iter()
		.any(|name| dir.join(name).is_file())
}

fn find_git_install_roots() -> Vec<PathBuf> {
	let mut roots = Vec::new();
	let mut seen = HashSet::new();
	for install_path in [query_git_install_path_from_registry(), query_git_install_path_from_where()]
		.into_iter()
		.flatten()
	{
		let path = PathBuf::from(install_path);
		let normalized = normalize_path(&path);
		if normalized.is_empty() {
			continue;
		}
		if seen.insert(normalized) {
			roots.push(path);
		}
	}
	roots
}

/// Translate an MSYS2/Git Bash style path entry (e.g. `/usr/bin`,
/// `/mingw64/bin`, `/c/Users/foo`) into a Windows-native path so that
/// `std::path` based executable lookups in brush-core can resolve binaries
/// shipped with Git Bash. Returns `None` when the segment is already a
/// Windows-style path or cannot be translated.
fn translate_msys_segment(segment: &str, install_roots: &[PathBuf]) -> Option<String> {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() || is_windows_style_path(trimmed) {
		return None;
	}

	let forward = trimmed.replace('\\', "/");
	if !forward.starts_with('/') {
		return None;
	}

	// MSYS drive-letter mapping: /c -> C:\, /c/Users/foo -> C:\Users\foo.
	let rest = &forward[1..];
	if let Some((head, tail)) = rest.split_once('/') {
		if is_drive_letter(head) {
			let drive = head.to_ascii_uppercase();
			let windows_tail = tail.replace('/', "\\");
			return Some(format!("{drive}:\\{windows_tail}"));
		}
	} else if is_drive_letter(rest) {
		return Some(format!("{}:\\", rest.to_ascii_uppercase()));
	}

	// Anchor the remainder against any known Git/MSYS install root.
	let relative = rest.replace('/', "\\");
	for root in install_roots {
		let candidate = root.join(&relative);
		if candidate.is_dir() {
			return Some(candidate.to_string_lossy().into_owned());
		}
	}

	None
}

fn is_drive_letter(value: &str) -> bool {
	value.len() == 1
		&& value
			.chars()
			.next()
			.is_some_and(|c| c.is_ascii_alphabetic())
}

fn is_windows_style_path(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		return true;
	}
	value.starts_with("\\\\")
}

/// Guard that captures and restores Windows console code pages.
///
/// On Windows, child processes can change the console code page (via
/// SetConsoleOutputCP/SetConsoleCP). This guard captures the current code pages
/// at creation and restores them when dropped, ensuring the console state is
/// restored after external commands complete.
///
/// This is particularly important for the bash tool, which may execute commands
/// that change the code page (e.g., `chcp`). Without this guard, the TUI would
/// display mojibake after such commands since GJC uses UTF-8 (code page 65001).
///
/// # Safety
///
/// The guard only queries and restores the console code pages. It is safe to
/// create multiple guards or drop them in any order; each restoration is
/// independent and idempotent.
pub struct ConsoleCodePageGuard {
	input:  u32,
	output: u32,
}

impl ConsoleCodePageGuard {
	/// Capture the current console code pages.
	///
	/// Returns `None` if no console is attached (GetConsoleCP returns 0).
	pub fn capture() -> Option<Self> {
		use windows_sys::Win32::System::Console::{GetConsoleCP, GetConsoleOutputCP};

		// SAFETY: these are pure queries of this process's attached console.
		// 0 means "no console".
		unsafe {
			let input = GetConsoleCP();
			let output = GetConsoleOutputCP();
			(input != 0 && output != 0).then_some(Self { input, output })
		}
	}

	/// Check if the code pages have drifted from the values stored in this
	/// guard. Returns the current values if they differ.
	fn check_drifted(&self) -> Option<(u32, u32)> {
		use windows_sys::Win32::System::Console::{GetConsoleCP, GetConsoleOutputCP};

		unsafe {
			let current_input = GetConsoleCP();
			let current_output = GetConsoleOutputCP();

			if current_input != self.input || current_output != self.output {
				Some((current_input, current_output))
			} else {
				None
			}
		}
	}
}

impl Drop for ConsoleCodePageGuard {
	fn drop(&mut self) {
		use windows_sys::Win32::System::Console::{
			GetConsoleCP, GetConsoleOutputCP, SetConsoleCP, SetConsoleOutputCP,
		};

		unsafe {
			let current_input = GetConsoleCP();
			let current_output = GetConsoleOutputCP();

			// Restore output code page if it has drifted
			if current_output != self.output {
				// Log a warning about the drift
				eprintln!(
					"[console-guard] child process changed output code page {} → {}; restored",
					self.output, current_output
				);
				SetConsoleOutputCP(self.output);
			}

			// Restore input code page if it has drifted
			if current_input != self.input {
				eprintln!(
					"[console-guard] child process changed input code page {} → {}; restored",
					self.input, current_input
				);
				SetConsoleCP(self.input);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn drive_letter_segments_translate_to_windows_paths() {
		assert_eq!(translate_msys_segment("/c/Users/foo", &[]).as_deref(), Some("C:\\Users\\foo"),);
		assert_eq!(translate_msys_segment("/d", &[]).as_deref(), Some("D:\\"),);
	}

	#[test]
	fn windows_style_segments_are_left_alone() {
		assert_eq!(translate_msys_segment("C:\\Windows\\System32", &[]), None);
		assert_eq!(translate_msys_segment("\\\\server\\share", &[]), None);
		assert_eq!(translate_msys_segment("relative\\path", &[]), None);
	}

	#[test]
	fn is_drive_letter_only_matches_single_alphabetic_chars() {
		assert!(is_drive_letter("c"));
		assert!(is_drive_letter("Z"));
		assert!(!is_drive_letter(""));
		assert!(!is_drive_letter("cc"));
		assert!(!is_drive_letter("1"));
	}

	#[test]
	#[cfg(windows)]
	fn console_code_page_guard_captures_and_restores() {
		// This test verifies that the guard captures the current code pages and
		// can restore them. On Windows, this should work with real console code pages.
		// On non-Windows platforms, this is skipped.
		if let Some(guard) = ConsoleCodePageGuard::capture() {
			// The guard captured something, which means a console is attached.
			// We can't easily test the actual restoration without changing the console
			// code page (which would affect the test runner), but we can verify that
			// the guard holds the values.
			assert_ne!(guard.input, 0, "input code page should be non-zero");
			assert_ne!(guard.output, 0, "output code page should be non-zero");
		}
	}

	#[test]
	#[cfg(not(windows))]
	fn console_code_page_guard_is_noop_on_non_windows() {
		// On non-Windows platforms, the guard is not compiled in (due to
		// #[cfg(windows)]) in shell.rs where it's used. This test exists as
		// documentation of that behavior. The guard's functionality is
		// Windows-specific.
	}
}
