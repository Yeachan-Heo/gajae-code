use std::{
	fs,
	path::PathBuf,
	process::{Command, Stdio},
	time::{Duration, Instant},
};

use super::{
	PtyRunConfig, run_pty_sync, task,
	tests::{PTY_TEST_LOCK, process_exists, test_config, test_path, wait_for_process_exit},
};

const SETSID_DOUBLE_FORK_SCRIPT: &str = r#"use POSIX;
my $pidfile = $ENV{PTY_ESCAPE_PID} or die "missing pidfile\n";
my $pid = fork();
die "fork: $!\n" unless defined $pid;
if ($pid == 0) {
	POSIX::setsid() == -1 and die "setsid: $!\n";
	my $child = fork();
	die "fork2: $!\n" unless defined $child;
	if ($child == 0) {
		my $original_ppid = getppid();
		open my $fh, ">", $pidfile or die "open: $!\n";
		print $fh "$$ $original_ppid\n";
		close $fh;
		sleep 60;
		exit 0;
	}
	select(undef, undef, undef, 0.5);
	exit 0;
}
sleep 60;
"#;

fn escape_config(script: &std::path::Path, pid_path: &std::path::Path) -> PtyRunConfig {
	let mut config = test_config("perl \"$PTY_ESCAPE_SCRIPT\"");
	let mut env = std::collections::HashMap::new();
	env.insert("PTY_ESCAPE_SCRIPT".to_string(), script.display().to_string());
	env.insert("PTY_ESCAPE_PID".to_string(), pid_path.display().to_string());
	config.env = Some(env);
	config
}

fn write_escape_script(name: &str) -> PathBuf {
	let script = test_path(name);
	fs::write(&script, SETSID_DOUBLE_FORK_SCRIPT).expect("write escape script");
	script
}

fn grandchild_ppid(pid: i32) -> Option<i32> {
	pi_shell::process::Process::from_pid(pid).and_then(|process| process.ppid())
}

fn child_identity(contents: &str) -> Option<(i32, i32)> {
	let mut fields = contents.split_whitespace();
	Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
}

fn wait_until_reparented(pid_path: &std::path::Path) -> i32 {
	let deadline = Instant::now() + Duration::from_secs(8);
	let mut grandchild_identity = None;
	while Instant::now() < deadline {
		if grandchild_identity.is_none()
			&& let Ok(text) = fs::read_to_string(pid_path)
			&& let Some(identity) = child_identity(&text)
		{
			grandchild_identity = Some(identity);
		}
		if let Some((pid, original_ppid)) = grandchild_identity
			&& grandchild_ppid(pid).is_some_and(|ppid| ppid != original_ppid)
		{
			return pid;
		}
		std::thread::sleep(Duration::from_millis(20));
	}
	panic!("setsid grandchild was not reparented; child={grandchild_identity:?}");
}

struct KillPid(i32);

impl Drop for KillPid {
	fn drop(&mut self) {
		if self.0 > 0 {
			unsafe { libc::kill(self.0, libc::SIGKILL) };
		}
	}
}

#[test]
fn unrelated_process_survives_pty_cancel() {
	let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
	let mut sibling = Command::new("sleep")
		.arg("30")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn unrelated process");
	let sibling_pid = i32::try_from(sibling.id()).expect("sibling pid fits i32");
	let _kill_sibling = KillPid(sibling_pid);
	let mut ct = task::CancelToken::new(Some(10_000), None);
	let abort = ct.emplace_abort_token();
	let (_tx, rx) = std::sync::mpsc::channel();
	let handle = std::thread::spawn(move || run_pty_sync(test_config("sleep 30"), None, rx, ct));
	std::thread::sleep(Duration::from_millis(300));
	abort.abort(task::AbortReason::Signal);
	let result = handle
		.join()
		.expect("PTY worker should not panic")
		.expect("cancelled PTY run should return a result");
	assert!(result.cancelled);
	assert!(process_exists(sibling_pid), "cancel killed an unrelated process");
	let _ = sibling.kill();
	let _ = sibling.wait();
}

#[test]
fn cancel_reaps_reparented_setsid_grandchild() {
	run_cancel_reap_case(None);
}

fn run_cancel_reap_case(expected_reaper_pid: Option<i32>) {
	let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
	let script = write_escape_script("cancel-escape.pl");
	let pid_path = test_path("cancel-escape.pid");
	let mut ct = task::CancelToken::new(Some(20_000), None);
	let abort = ct.emplace_abort_token();
	let config = escape_config(&script, &pid_path);
	let (_tx, rx) = std::sync::mpsc::channel();
	let handle = std::thread::spawn(move || run_pty_sync(config, None, rx, ct));
	let grandchild = wait_until_reparented(&pid_path);
	if let Some(expected_pid) = expected_reaper_pid {
		assert_eq!(
			grandchild_ppid(grandchild),
			Some(expected_pid),
			"subreaper must adopt the setsid grandchild"
		);
	}
	let _kill_grandchild = KillPid(grandchild);
	abort.abort(task::AbortReason::Signal);
	let result = handle
		.join()
		.expect("PTY worker should not panic")
		.expect("cancelled PTY run should return a result");
	assert!(result.cancelled, "cancel should mark the PTY run cancelled");
	assert!(
		wait_for_process_exit(grandchild, Duration::from_secs(3)),
		"reparented setsid grandchild {grandchild} survived cancel"
	);
	let _ = fs::remove_file(&script);
	let _ = fs::remove_file(&pid_path);
}

#[cfg(target_os = "linux")]
#[test]
fn cancel_reaps_adopted_setsid_grandchild_for_subreaper() {
	const CHILD_MODE: &str = "PI_NATIVES_TEST_SUBREAPER_CHILD";
	if std::env::var_os(CHILD_MODE).is_some() {
		// Isolate the process-wide subreaper setting from the rest of the test
		// harness, then exercise the same orphan-adoption path as namespace PID 1.
		// SAFETY: PR_SET_CHILD_SUBREAPER changes only this test process's setting.
		let result = unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) };
		assert_eq!(result, 0, "enable child subreaper");
		let self_pid = i32::try_from(std::process::id()).expect("test pid fits i32");
		run_cancel_reap_case(Some(self_pid));
		return;
	}

	let current_thread = std::thread::current();
	let test_name = current_thread.name().expect("test thread has a name");
	let output = Command::new(std::env::current_exe().expect("test executable path"))
		.args(["--exact", test_name])
		.env(CHILD_MODE, "1")
		.output()
		.expect("start isolated subreaper test process");
	assert!(
		output.status.success(),
		"subreaper regression subprocess failed\nstdout:\n{}\nstderr:\n{}",
		String::from_utf8_lossy(&output.stdout),
		String::from_utf8_lossy(&output.stderr),
	);
}

#[test]
fn timeout_reaps_reparented_setsid_grandchild() {
	let _guard = PTY_TEST_LOCK.lock().unwrap_or_else(|err| err.into_inner());
	let script = write_escape_script("timeout-escape.pl");
	let pid_path = test_path("timeout-escape.pid");
	let config = escape_config(&script, &pid_path);
	let (_tx, rx) = std::sync::mpsc::channel();
	let result = run_pty_sync(config, None, rx, task::CancelToken::new(Some(4_000), None))
		.expect("timed-out PTY run should return a result");
	assert!(result.timed_out, "PTY run should time out");
	let grandchild: i32 = fs::read_to_string(&pid_path)
		.expect("grandchild pid file should be written before timeout")
		.split_whitespace()
		.next()
		.expect("pid file should contain a pid")
		.parse()
		.expect("pid file should contain a numeric pid");
	let _kill_grandchild = KillPid(grandchild);
	assert!(
		wait_for_process_exit(grandchild, Duration::from_secs(3)),
		"reparented setsid grandchild {grandchild} survived timeout"
	);
	let _ = fs::remove_file(&script);
	let _ = fs::remove_file(&pid_path);
}
