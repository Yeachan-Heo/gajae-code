//! Isolation git children must not inherit the git config channel.
//! Unix hook bits. Win32 prints `ignored` for those cases.

use std::{
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	process::Command,
};

use pi_iso::{BackendKind, backend};

enum GitLocate {
	Found(PathBuf),
	Skip(&'static str),
}

struct HarnessSkip {
	reason: &'static str,
}

fn skip(reason: &'static str) -> ! {
	std::panic::panic_any(HarnessSkip { reason });
}

fn scratch(label: &str) -> PathBuf {
	let nanos = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.expect("clock")
		.as_nanos();
	let dir = std::env::temp_dir()
		.join(format!("pi-iso-git-config-{label}-{}-{nanos}", std::process::id()));
	let _ = fs::remove_dir_all(&dir);
	fs::create_dir_all(dir.join("home")).unwrap();
	dir
}

fn is_executable_file(path: &Path) -> bool {
	let Ok(meta) = fs::metadata(path) else {
		return false;
	};
	if !meta.is_file() {
		return false;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		meta.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		let _ = (path, meta);
		true
	}
}

const fn git_name() -> &'static str {
	if cfg!(windows) { "git.exe" } else { "git" }
}

/// First *executable* `git` on `path_env`. A non-executable namesake is
/// skipped.
fn locate_executable(path_env: &std::ffi::OsStr) -> GitLocate {
	for dir in std::env::split_paths(path_env) {
		let candidate = dir.join(git_name());
		if is_executable_file(&candidate) {
			return GitLocate::Found(candidate);
		}
	}
	GitLocate::Skip("no executable git")
}

fn runs_git_version(path: &Path) -> bool {
	let mut path_env = path
		.parent()
		.unwrap_or_else(|| Path::new(""))
		.as_os_str()
		.to_os_string();
	path_env.push(if cfg!(windows) { ";" } else { ":" });
	path_env.push("/usr/bin:/bin");
	Command::new(path)
		.arg("--version")
		.env_clear()
		.env("PATH", &path_env)
		.env("HOME", std::env::temp_dir())
		.stdin(std::process::Stdio::null())
		.stdout(std::process::Stdio::null())
		.stderr(std::process::Stdio::null())
		.status()
		.is_ok_and(|status| status.success())
}

fn locate_runnable_git(path_env: &std::ffi::OsStr) -> GitLocate {
	for dir in std::env::split_paths(path_env) {
		let candidate = dir.join(git_name());
		if is_executable_file(&candidate) && runs_git_version(&candidate) {
			return GitLocate::Found(candidate);
		}
	}
	GitLocate::Skip("no executable git")
}

fn require_host_git() -> PathBuf {
	let path = std::env::var_os("PATH").unwrap_or_default();
	match locate_runnable_git(&path) {
		GitLocate::Found(path) => path,
		GitLocate::Skip(reason) => skip(reason),
	}
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) {
	use std::os::unix::fs::PermissionsExt;
	let mut perms = fs::metadata(path).unwrap().permissions();
	perms.set_mode(mode);
	fs::set_permissions(path, perms).unwrap();
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) {}

fn write_wrapper(dir: &Path, _real_git: &Path) {
	fs::create_dir_all(dir).unwrap();
	let git = dir.join(git_name());
	fs::write(
		&git,
		"#!/bin/sh\nprintf '%s\\n' ok >> \"$PI_ISO_WHICH\"\nexec \"$PI_ISO_REAL_GIT\" \"$@\"\n",
	)
	.unwrap();
	#[cfg(unix)]
	set_mode(&git, 0o755);
}

fn reexec(
	test_name: &str,
	label: &str,
	root: &Path,
	path: &std::ffi::OsStr,
	extra: &[(&str, &str)],
) -> std::process::ExitStatus {
	let mut cmd = Command::new(std::env::current_exe().unwrap());
	cmd.env_clear();
	cmd.env("PI_ISO_INNER", label);
	cmd.env("PI_ISO_ROOT", root);
	let home = root.join("home");
	cmd.env("HOME", &home);
	cmd.env("USERPROFILE", &home);
	cmd.env("TMPDIR", root);
	// Caller supplies the git directory ahead of /usr/bin:/bin.
	cmd.env("PATH", path);
	for (key, value) in extra {
		cmd.env(key, value);
	}
	cmd.args(["--exact", test_name, "--test-threads=1"]);
	cmd.status().expect("reexec")
}

fn git_init(repo: &Path, args: &[&str]) {
	let program = std::env::var_os("PI_ISO_GIT").expect("PI_ISO_GIT");
	let status = Command::new(&program)
		.current_dir(repo)
		.args(args)
		.env_clear()
		.env("PATH", std::env::var_os("PATH").unwrap())
		.env("HOME", std::env::var_os("HOME").unwrap())
		.env("USERPROFILE", std::env::var_os("USERPROFILE").unwrap())
		.env("TMPDIR", std::env::var_os("TMPDIR").unwrap())
		.env("PI_ISO_REAL_GIT", std::env::var_os("PI_ISO_REAL_GIT").unwrap())
		.env("PI_ISO_WHICH", std::env::var_os("PI_ISO_WHICH").unwrap())
		.status()
		.expect("git");
	assert!(status.success(), "git {args:?} via {}", program.display());
}

fn init_repo(repo: &Path, marker: &Path) {
	fs::create_dir_all(repo.join(".hooks")).unwrap();
	let hook = repo.join(".hooks").join("post-checkout");
	let marker_text = marker.to_string_lossy();
	assert!(!marker_text.contains('\''), "marker path");
	fs::write(&hook, format!("#!/bin/sh\necho ran > '{marker_text}'\n")).unwrap();
	#[cfg(unix)]
	set_mode(&hook, 0o755);
	git_init(repo, &["init", "-q", "-b", "main"]);
	git_init(repo, &["config", "user.email", "test@example.com"]);
	git_init(repo, &["config", "user.name", "test"]);
	fs::write(repo.join("a.txt"), "hi\n").unwrap();
	git_init(repo, &["add", ".hooks/post-checkout", "a.txt"]);
	git_init(repo, &["commit", "-q", "-m", "init"]);
}

fn assert_channel_absent(text: &str) {
	assert!(text.contains("BEGIN"), "git was not spawned: {text}");
	for key in [
		"GIT_CONFIG_COUNT=",
		"GIT_CONFIG_KEY_0=",
		"GIT_CONFIG_VALUE_0=",
		"GIT_CONFIG_KEY_1=",
		"GIT_CONFIG_VALUE_1=",
		"GIT_CONFIG_PARAMETERS=",
		"GIT_CONFIG_GLOBAL=",
		"GIT_CONFIG_SYSTEM=",
		"git_config_count=",
		"Git_Config_Key_3=",
	] {
		assert!(!text.contains(key), "child kept {key}");
	}
	assert!(text.contains("GIT_AUTHOR_NAME= Kept Name "), "{text}");
	assert!(text.contains("GIT_CONFIG_NOSYSTEM=1"), "{text}");
	assert!(text.contains("GIT_CONFIG_COUNTER=1"), "{text}");
	assert!(text.contains("GIT_CONFIG_KEY_=kept"), "{text}");
	assert!(text.contains("git_author_name=kept"), "{text}");
	assert!(text.contains("GIT_CONFIG_COUNT =kept"), "{text}");
}

/// `git` on PATH that is this test binary; `main` dumps the environment it
/// received. A `/bin/sh` script would not do: dash drops environment names
/// that are not shell identifiers (`GIT_CONFIG_COUNT `) before exec.
#[cfg(unix)]
fn write_fake_git(dir: &Path) {
	fs::create_dir_all(dir).unwrap();
	std::os::unix::fs::symlink(std::env::current_exe().unwrap(), dir.join(git_name())).unwrap();
}

/// Fake `git` mode: append `BEGIN` and the received environment verbatim.
fn dump_env_as_fake_git() -> bool {
	let invoked_as_git = std::env::args_os()
		.next()
		.is_some_and(|argv0| Path::new(&argv0).file_name() == Some(std::ffi::OsStr::new(git_name())));
	let Some(log) = std::env::var_os("PI_ISO_ENV_LOG").filter(|_| invoked_as_git) else {
		return false;
	};
	let mut text = String::from("BEGIN\n");
	for (key, value) in std::env::vars_os() {
		let _ = writeln!(text, "{}={}", key.to_string_lossy(), value.to_string_lossy());
	}
	let mut file = fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(log)
		.expect("env log");
	std::io::Write::write_all(&mut file, text.as_bytes()).expect("write env log");
	true
}

fn inner_hooks() {
	let root = PathBuf::from(std::env::var("PI_ISO_ROOT").unwrap());
	let repo = root.join("repo");
	init_repo(&repo, &root.join("marker"));
	backend(BackendKind::Rcopy)
		.start(&repo, &root.join("merged"))
		.expect("start");
}

fn inner_plain() {
	let root = PathBuf::from(std::env::var("PI_ISO_ROOT").unwrap());
	let repo = root.join("repo");
	init_repo(&repo, &root.join("marker"));
	backend(BackendKind::Rcopy)
		.start(&repo, &root.join("merged"))
		.expect("start");
}

fn inner_child() {
	let root = PathBuf::from(std::env::var("PI_ISO_ROOT").unwrap());
	backend(BackendKind::Rcopy)
		.start(&root.join("lower"), &root.join("merged"))
		.expect("start");
}

fn inner_diff() {
	let root = PathBuf::from(std::env::var("PI_ISO_ROOT").unwrap());
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	runtime
		.block_on(backend(BackendKind::Rcopy).diff(&root.join("lower"), &root.join("merged")))
		.expect("diff");
}

fn inner_nongit() {
	let root = PathBuf::from(std::env::var("PI_ISO_ROOT").unwrap());
	backend(BackendKind::Rcopy)
		.start(&root.join("lower"), &root.join("merged"))
		.expect("start");
}

#[cfg(unix)]
fn custom_directory_only() {
	let root = scratch("custom");
	let bin = root.join("custom");
	write_fake_git(&bin);
	match locate_executable(bin.as_os_str()) {
		GitLocate::Found(path) => assert_eq!(path, bin.join("git")),
		GitLocate::Skip(reason) => panic!("custom dir git was skipped: {reason}"),
	}
	let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
fn non_executable_git_ahead() {
	let root = scratch("decoy");
	let decoy = root.join("decoy");
	let real = root.join("real");
	fs::create_dir_all(&decoy).unwrap();
	fs::write(decoy.join("git"), "not executable\n").unwrap();
	set_mode(&decoy.join("git"), 0o644);
	write_fake_git(&real);
	let mut path = decoy.as_os_str().to_os_string();
	path.push(":");
	path.push(real.as_os_str());
	match locate_executable(&path) {
		GitLocate::Found(found) => assert_eq!(found, real.join("git")),
		GitLocate::Skip(reason) => panic!("runnable git was skipped: {reason}"),
	}
	let _ = fs::remove_dir_all(&root);
}

fn absent_git_is_explicit_skip() {
	let root = scratch("absent");
	match locate_executable(root.as_os_str()) {
		GitLocate::Skip(reason) => assert_eq!(reason, "no executable git"),
		GitLocate::Found(path) => panic!("found {} on an empty path", path.display()),
	}
	let _ = fs::remove_dir_all(&root);
}

fn channel_env<'a>() -> Vec<(&'a str, &'a str)> {
	vec![
		("GIT_CONFIG_COUNT", "1"),
		("GIT_CONFIG_KEY_0", "core.hooksPath"),
		("GIT_CONFIG_VALUE_0", "/hooks"),
		("GIT_CONFIG_KEY_1", "core.fsmonitor"),
		("GIT_CONFIG_VALUE_1", "./hook.sh"),
		("GIT_CONFIG_PARAMETERS", "core.hooksPath=/hooks"),
		("GIT_CONFIG_GLOBAL", "/cfg"),
		("GIT_CONFIG_SYSTEM", "/system"),
		("git_config_count", "1"),
		("Git_Config_Key_3", "core.hooksPath"),
		("GIT_AUTHOR_NAME", " Kept Name "),
		("GIT_CONFIG_NOSYSTEM", "1"),
		("GIT_CONFIG_COUNTER", "1"),
		("GIT_CONFIG_KEY_", "kept"),
		("git_author_name", "kept"),
		("GIT_CONFIG_COUNT ", "kept"),
	]
}

fn joined_path(dirs: &[&Path]) -> std::ffi::OsString {
	let mut path = std::ffi::OsString::new();
	for (index, dir) in dirs.iter().enumerate() {
		if index > 0 {
			path.push(":");
		}
		path.push(dir.as_os_str());
	}
	path.push(":");
	path.push("/usr/bin:/bin");
	path
}

#[cfg(unix)]
fn rcopy_start_ignores_git_config_hooks_path() {
	if std::env::var("PI_ISO_INNER").ok().as_deref() == Some("hooks") {
		inner_hooks();
		return;
	}
	let real = require_host_git();
	let root = scratch("hooks");
	let decoy = root.join("decoy");
	fs::create_dir_all(&decoy).unwrap();
	fs::write(decoy.join("git"), "not executable\n").unwrap();
	set_mode(&decoy.join("git"), 0o644);
	let custom = root.join("custom");
	write_wrapper(&custom, &real);
	let which = root.join("which");
	let hooks = root.join("repo").join(".hooks");
	let status = reexec(
		"rcopy_start_ignores_git_config_hooks_path",
		"hooks",
		&root,
		&joined_path(&[&decoy, &custom]),
		&[
			("PI_ISO_GIT", &custom.join("git").to_string_lossy()),
			("PI_ISO_REAL_GIT", &real.to_string_lossy()),
			("PI_ISO_WHICH", &which.to_string_lossy()),
			("GIT_CONFIG_COUNT", "1"),
			("GIT_CONFIG_KEY_0", "core.hooksPath"),
			("GIT_CONFIG_VALUE_0", &hooks.to_string_lossy()),
			("GIT_AUTHOR_NAME", " Kept Name "),
			("GIT_CONFIG_NOSYSTEM", "1"),
		],
	);
	assert!(status.success(), "inner status {status}");
	assert!(fs::read_to_string(&which).unwrap().contains("ok"), "custom git was not used");
	assert!(!root.join("marker").exists(), "post-checkout hook ran");
	assert_eq!(fs::read_to_string(root.join("merged").join("a.txt")).unwrap(), "hi\n");
	let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
fn rcopy_start_keeps_checkout_without_git_config_env() {
	if std::env::var("PI_ISO_INNER").ok().as_deref() == Some("plain") {
		inner_plain();
		return;
	}
	let real = require_host_git();
	let root = scratch("plain");
	let custom = root.join("custom");
	write_wrapper(&custom, &real);
	let which = root.join("which");
	let status = reexec(
		"rcopy_start_keeps_checkout_without_git_config_env",
		"plain",
		&root,
		&joined_path(&[&custom]),
		&[
			("PI_ISO_GIT", &custom.join("git").to_string_lossy()),
			("PI_ISO_REAL_GIT", &real.to_string_lossy()),
			("PI_ISO_WHICH", &which.to_string_lossy()),
			("GIT_AUTHOR_NAME", " Kept Name "),
			("GIT_CONFIG_NOSYSTEM", "1"),
		],
	);
	assert!(status.success(), "inner status {status}");
	assert!(!root.join("marker").exists(), "hook ran without the config channel");
	assert_eq!(fs::read_to_string(root.join("merged").join("a.txt")).unwrap(), "hi\n");
	let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
fn rcopy_git_child_drops_git_config_env() {
	if std::env::var("PI_ISO_INNER").ok().as_deref() == Some("child") {
		inner_child();
		return;
	}
	let root = scratch("child");
	let bin = root.join("bin");
	write_fake_git(&bin);
	let lower = root.join("lower");
	fs::create_dir_all(&lower).unwrap();
	fs::write(lower.join(".git"), "gitdir: /unused\n").unwrap();
	let log = root.join("child-env");
	let log_s = log.to_string_lossy().into_owned();
	let mut extra = vec![("PI_ISO_ENV_LOG", log_s.as_str())];
	let owned = channel_env();
	for (key, value) in &owned {
		extra.push((key, value));
	}
	let status =
		reexec("rcopy_git_child_drops_git_config_env", "child", &root, &joined_path(&[&bin]), &extra);
	assert!(status.success(), "inner status {status}");
	assert_channel_absent(&fs::read_to_string(&log).unwrap());
	let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
fn git_diff_child_drops_git_config_env() {
	if std::env::var("PI_ISO_INNER").ok().as_deref() == Some("diff") {
		inner_diff();
		return;
	}
	let root = scratch("diff");
	let bin = root.join("bin");
	write_fake_git(&bin);
	fs::create_dir_all(root.join("lower")).unwrap();
	let merged = root.join("merged");
	fs::create_dir_all(&merged).unwrap();
	fs::write(merged.join(".git"), "gitdir: /unused\n").unwrap();
	let log = root.join("child-env");
	let log_s = log.to_string_lossy().into_owned();
	let mut extra = vec![("PI_ISO_ENV_LOG", log_s.as_str())];
	let owned = channel_env();
	for (key, value) in &owned {
		extra.push((key, value));
	}
	let status =
		reexec("git_diff_child_drops_git_config_env", "diff", &root, &joined_path(&[&bin]), &extra);
	assert!(status.success(), "inner status {status}");
	assert_channel_absent(&fs::read_to_string(&log).unwrap());
	let _ = fs::remove_dir_all(&root);
}

#[cfg(unix)]
fn rcopy_nongit_copy_ignores_git_config_env() {
	if std::env::var("PI_ISO_INNER").ok().as_deref() == Some("nongit") {
		inner_nongit();
		return;
	}
	let root = scratch("nongit");
	let bin = root.join("bin");
	write_fake_git(&bin);
	let lower = root.join("lower");
	fs::create_dir_all(&lower).unwrap();
	fs::write(lower.join("a.txt"), "hi\n").unwrap();
	let log = root.join("child-env");
	let log_s = log.to_string_lossy().into_owned();
	let status = reexec(
		"rcopy_nongit_copy_ignores_git_config_env",
		"nongit",
		&root,
		&joined_path(&[&bin]),
		&[
			("PI_ISO_ENV_LOG", log_s.as_str()),
			("GIT_CONFIG_COUNT", "1"),
			("GIT_CONFIG_KEY_0", "core.hooksPath"),
			("GIT_CONFIG_VALUE_0", "/hooks"),
			("GIT_AUTHOR_NAME", " Kept Name "),
		],
	);
	assert!(status.success(), "inner status {status}");
	assert!(!log.exists(), "non-git copy spawned git");
	assert_eq!(fs::read_to_string(root.join("merged").join("a.txt")).unwrap(), "hi\n");
	let _ = fs::remove_dir_all(&root);
}

fn git_config_env_lists_for_nextest() {
	let exe = std::env::current_exe().unwrap();
	let list = Command::new(&exe)
		.args(["--list", "--format", "terse"])
		.output()
		.expect("list");
	let text = String::from_utf8(list.stdout).expect("utf8");
	assert!(list.status.success(), "{text}{}", String::from_utf8_lossy(&list.stderr));
	let lines: Vec<&str> = text.lines().collect();
	let expected: Vec<String> = cases()
		.iter()
		.map(|case| format!("{}: test", case.name))
		.collect();
	assert_eq!(lines, expected.iter().map(String::as_str).collect::<Vec<_>>());
	let ignored = Command::new(&exe)
		.args(["--list", "--format=terse", "--ignored"])
		.output()
		.expect("ignored list");
	assert!(ignored.status.success(), "{}", String::from_utf8_lossy(&ignored.stderr));
	assert_eq!(String::from_utf8_lossy(&ignored.stdout).trim(), "");
	let one = Command::new(&exe)
		.args(["--list", "--format", "terse", "--exact", "absent_git_is_explicit_skip"])
		.output()
		.expect("exact list");
	assert!(one.status.success(), "{}", String::from_utf8_lossy(&one.stderr));
	assert_eq!(String::from_utf8_lossy(&one.stdout).trim(), "absent_git_is_explicit_skip: test");
}

fn checkout_tests_are_ignored_without_git() {
	if !cfg!(unix) {
		skip("unix shell git and hook mode bits");
	}
	let root = scratch("nogit");
	let output = Command::new(std::env::current_exe().unwrap())
		.env_clear()
		.env("PATH", &root)
		.env("HOME", root.join("home"))
		.env("USERPROFILE", root.join("home"))
		.env("TMPDIR", &root)
		.args([
			"--exact",
			"rcopy_start_ignores_git_config_hooks_path",
			"--exact",
			"rcopy_start_keeps_checkout_without_git_config_env",
		])
		.output()
		.expect("reexec without git");
	let text = String::from_utf8_lossy(&output.stdout);
	assert!(output.status.success(), "{text}{}", String::from_utf8_lossy(&output.stderr));
	assert!(text.contains("rcopy_start_ignores_git_config_hooks_path"), "{text}");
	assert!(text.contains("rcopy_start_keeps_checkout_without_git_config_env"), "{text}");
	assert!(text.contains("ignored"), "{text}");
	assert!(!text.contains("FAILED"), "{text}");
	let _ = fs::remove_dir_all(&root);
}

struct Case {
	name: &'static str,
	func: fn(),
}

fn cases() -> Vec<Case> {
	let mut out =
		vec![Case { name: "absent_git_is_explicit_skip", func: absent_git_is_explicit_skip }, Case {
			name: "git_config_env_lists_for_nextest",
			func: git_config_env_lists_for_nextest,
		}];
	#[cfg(unix)]
	out.extend([
		Case { name: "custom_directory_only", func: custom_directory_only },
		Case { name: "non_executable_git_ahead", func: non_executable_git_ahead },
		Case {
			name: "rcopy_start_ignores_git_config_hooks_path",
			func: rcopy_start_ignores_git_config_hooks_path,
		},
		Case {
			name: "rcopy_start_keeps_checkout_without_git_config_env",
			func: rcopy_start_keeps_checkout_without_git_config_env,
		},
		Case {
			name: "rcopy_git_child_drops_git_config_env",
			func: rcopy_git_child_drops_git_config_env,
		},
		Case {
			name: "git_diff_child_drops_git_config_env",
			func: git_diff_child_drops_git_config_env,
		},
		Case {
			name: "rcopy_nongit_copy_ignores_git_config_env",
			func: rcopy_nongit_copy_ignores_git_config_env,
		},
		Case {
			name: "checkout_tests_are_ignored_without_git",
			func: checkout_tests_are_ignored_without_git,
		},
	]);
	out
}

struct RunArgs {
	list:         bool,
	ignored_only: bool,
	exact:        bool,
	filters:      Vec<String>,
}

fn run_args() -> RunArgs {
	let mut parsed = RunArgs {
		list:         false,
		ignored_only: false,
		exact:        false,
		filters:      Vec::new(),
	};
	let mut args = std::env::args().skip(1);
	while let Some(arg) = args.next() {
		if arg.starts_with("--format=") {
			continue;
		}
		match arg.as_str() {
			"--list" => parsed.list = true,
			"--ignored" => parsed.ignored_only = true,
			"--exact" => parsed.exact = true,
			"--format" | "--test-threads" | "--skip" | "--logfile" | "--color" => {
				let _ = args.next();
			},
			flag if flag.starts_with('-') => {},
			other => parsed.filters.push(other.to_string()),
		}
	}
	parsed
}

fn selected<'a>(all: &'a [Case], parsed: &RunArgs) -> Vec<&'a Case> {
	all.iter()
		.filter(|case| {
			parsed.filters.is_empty()
				|| parsed.filters.iter().any(|filter| {
					if parsed.exact {
						case.name == filter
					} else {
						case.name.contains(filter)
					}
				})
		})
		.collect()
}

fn main() {
	if dump_env_as_fake_git() {
		return;
	}
	if let Ok(label) = std::env::var("PI_ISO_INNER") {
		let result =
			std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match label.as_str() {
				"hooks" => inner_hooks(),
				"plain" => inner_plain(),
				"child" => inner_child(),
				"diff" => inner_diff(),
				"nongit" => inner_nongit(),
				other => panic!("unknown inner {other}"),
			}));
		if result.is_err() {
			std::process::exit(1);
		}
		return;
	}
	let all = cases();
	let parsed = run_args();
	let chosen = selected(&all, &parsed);
	// Nextest lists with `--list --format terse` and runs one name via
	// `--exact`. Nothing is statically ignored; a missing git skips at run time.
	if parsed.list {
		if !parsed.ignored_only {
			for case in &chosen {
				println!("{}: test", case.name);
			}
		}
		return;
	}
	let mut failed = 0usize;
	let mut ignored = 0usize;
	for case in &chosen {
		print!("test {} ... ", case.name);
		let _ = std::io::Write::flush(&mut std::io::stdout());
		match std::panic::catch_unwind(std::panic::AssertUnwindSafe(case.func)) {
			Ok(()) => println!("ok"),
			Err(payload) => {
				if let Some(skipped) = payload.downcast_ref::<HarnessSkip>() {
					ignored += 1;
					println!("ignored, {}", skipped.reason);
				} else {
					failed += 1;
					println!("FAILED");
					if let Some(message) = payload.downcast_ref::<String>() {
						println!("{message}");
					} else if let Some(message) = payload.downcast_ref::<&str>() {
						println!("{message}");
					}
				}
			},
		}
	}
	println!(
		"test result: {}. {} ran; {ignored} ignored; {failed} failed",
		if failed == 0 { "ok" } else { "FAILED" },
		chosen.len()
	);
	if failed != 0 {
		std::process::exit(1);
	}
}
