use std::{
	collections::HashSet,
	process::{Command, Stdio},
	thread,
	time::Duration,
};

use super::{
	super::DescendantBaseline, ProcInfo, Process, WALK_IDENTITY_SCRIPT, WalkIdentity,
	build_process_tree,
};

#[test]
fn unreadable_identity_stays_unknown() {
	let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
	let live = Process::from_pid(self_pid).expect("live self");
	let _clear = ClearScript;
	WALK_IDENTITY_SCRIPT.with(|script| script.borrow_mut().push(WalkIdentity::Unreadable));
	assert!(live.descendants_observed().is_none(), "first lookup failure became an empty set");
	WALK_IDENTITY_SCRIPT.with(|script| {
		*script.borrow_mut() = vec![WalkIdentity::Same, WalkIdentity::Unreadable];
	});
	assert!(live.descendants_observed().is_none(), "second lookup failure became an empty set");
	WALK_IDENTITY_SCRIPT.with(|script| {
		*script.borrow_mut() = vec![WalkIdentity::Unreadable; 3];
	});
	assert!(
		!DescendantBaseline::capture().observed(),
		"unreadable identity confirmed an empty baseline"
	);
}

#[test]
fn descendant_walk_skips_a_recycled_child_snapshot() {
	let mut child = Command::new("sleep")
		.arg("30")
		.stdin(Stdio::null())
		.stdout(Stdio::null())
		.stderr(Stdio::null())
		.spawn()
		.expect("spawn sleep child");
	let child_pid = i32::try_from(child.id()).expect("child pid fits i32");
	let self_pid = i32::try_from(std::process::id()).expect("self pid fits i32");
	let parent = Process::from_pid(self_pid).expect("live self");
	let deadline = std::time::Instant::now() + Duration::from_secs(2);
	let mut tree = loop {
		let snapshot = build_process_tree().expect("process table snapshot");
		if snapshot
			.get(&self_pid)
			.is_some_and(|children| children.iter().any(|process| process.pid == child_pid))
		{
			break snapshot;
		}
		assert!(std::time::Instant::now() < deadline, "child missing from process snapshot");
		thread::sleep(Duration::from_millis(10));
	};
	let child_snapshot = tree
		.get_mut(&self_pid)
		.and_then(|children| children.iter_mut().find(|process| process.pid == child_pid))
		.expect("child snapshot");
	child_snapshot.start_tvsec = child_snapshot.start_tvsec.wrapping_add(1);
	let mut visited = HashSet::from([self_pid]);
	let mut descendants = Vec::new();
	Process::collect_descendants_from_tree(&parent, &tree, &mut visited, &mut descendants);
	let _ = child.kill();
	let _ = child.wait();
	assert!(
		descendants.iter().all(|process| process.pid() != child_pid),
		"a PID whose captured incarnation no longer matches must not be retained"
	);
}

struct ClearScript;

impl Drop for ClearScript {
	fn drop(&mut self) {
		WALK_IDENTITY_SCRIPT.with(|script| script.borrow_mut().clear());
	}
}
