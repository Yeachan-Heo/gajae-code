//! A terminated-but-unreaped child must observe as positively absent: death
//! proof cannot depend on an unrelated parent's reaping schedule.
#![cfg(unix)]

use std::{
	process::{Command, Stdio},
	thread,
	time::{Duration, Instant},
};

use pi_shell::process::{Process, ProcessObservation};

#[test]
fn terminated_unreaped_child_observes_as_absent() {
	let mut child = Command::new("/bin/sh")
		.args(["-c", "exit 0"])
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn short-lived child");
	let pid = i32::try_from(child.id()).expect("child pid fits in i32");

	// Deliberately do not reap: the child stays a zombie while this process
	// holds its exit status, which is exactly the state a doctor restart sees
	// when the old owner exits under a still-running supervisor.
	let deadline = Instant::now() + Duration::from_secs(10);
	let mut observation = Process::observe(pid);
	while Instant::now() < deadline && !matches!(observation, ProcessObservation::Absent) {
		thread::sleep(Duration::from_millis(20));
		observation = Process::observe(pid);
	}
	assert_eq!(
		observation,
		ProcessObservation::Absent,
		"an exited-but-unreaped child must be positively absent, not live",
	);
	// The zombie is still in the process table, so this is genuinely the
	// unreaped state and not a post-reap observation.
	// SAFETY: signal 0 performs error checking only and delivers no signal.
	assert_eq!(unsafe { libc::kill(pid, 0) }, 0, "child must still be unreaped");

	child.wait().expect("reap child");
	assert_eq!(Process::observe(pid), ProcessObservation::Absent);
}
