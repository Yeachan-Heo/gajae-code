//! Ownership proof for process-tree walks on platforms that do not reparent
//! orphans (Windows).
//!
//! A Windows process keeps the number of its creator in
//! `th32ParentProcessID` after the creator exits, and the kernel hands that
//! number to later, unrelated processes. A walk keyed only on parent numbers
//! therefore adopts every orphan whose dead parent's number was reused,
//! together with the orphan's whole subtree.
//!
//! The selection here is a pure function of a process-table snapshot and of
//! per-candidate identity read through a handle that pins the candidate's
//! kernel object.
//!
//! # Ownership invariant
//!
//! A non-root process `P` is selected only if there is a chain
//! `root = A0, A1, …, Ak = P` where, for every `i >= 1`:
//!
//! - `Ai` is not PID 0 or 4 and not in the protected set (the current process
//!   and its ancestors);
//! - `Ai`'s identity was read through a handle (`resolve` returned `Some`), and
//!   that handle reports the process as running;
//! - the snapshot parent number and the handle's parent number of `Ai` both
//!   equal the pid of `A(i-1)`;
//! - `creation(Ai) > creation(A(i-1))`, strictly.
//!
//! Why this proves `A(i-1)` created `Ai`: the walker holds a handle to
//! `A(i-1)` (the root's caller-owned handle, or the handle `resolve` opened),
//! so `A(i-1)`'s kernel object exists now. A PID number is released only when
//! its process object is destroyed, so that number has named `A(i-1)` without
//! interruption from `creation(A(i-1))` until now. `Ai` was created at
//! `creation(Ai)`, inside that interval, and recorded its creator's number at
//! that moment; the number named `A(i-1)` then. Equal timestamps cannot rule
//! out that the previous holder of the number created `Ai` in the same clock
//! tick, so they are not accepted. Anything that cannot be proven this way —
//! unreadable identity, a parent number that changed between the snapshot and
//! the open, an older creation time — is neither selected nor walked through.
//!
//! The proof relies on process creation times coming from a clock that is not
//! stepped backwards between the two creations; see the caller's
//! documentation for that limit.

use std::collections::{HashMap, HashSet};

/// PIDs that never belong to a command tree: the System Idle Process (0) and
/// the System process (4).
pub const RESERVED_PIDS: [u32; 2] = [0, 4];

/// One row of a process-table snapshot (Toolhelp on Windows).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SnapshotEntry {
	pub pid:        u32,
	pub parent_pid: u32,
}

/// Identity of a candidate read through a handle that pins its kernel object,
/// so every field describes the same process incarnation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PinnedIdentity {
	pub parent_pid:    u32,
	pub creation_time: u64,
	pub running:       bool,
}

/// Whether `candidate` is provably a child of the pinned process
/// `(parent_pid, parent_creation_time)`.
pub const fn is_owned_child(
	parent_pid: u32,
	parent_creation_time: u64,
	candidate: SnapshotEntry,
	identity: PinnedIdentity,
) -> bool {
	candidate.parent_pid == parent_pid
		&& identity.parent_pid == parent_pid
		&& identity.creation_time > parent_creation_time
		&& identity.running
}

/// Result of a [`owned_descendants`] walk: the set of provably owned PIDs and
/// whether the observation was complete (all candidates' identities were
/// successfully resolved).
///
/// If `complete` is false, some candidates in the descent chain could not have
/// their identities read, so the result is incomplete and should not be treated
/// as a proven baseline.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnedDescendantsResult {
	/// PIDs of provably owned descendants, deepest first (post-order).
	pub pids:     Vec<u32>,
	/// Whether all candidates in the descent chain were successfully resolved.
	/// If false, the observation is incomplete and should not be cached or used
	/// as a baseline for determining which processes are new.
	pub complete: bool,
}

/// Select the provably owned descendants of the pinned root, at most
/// `depth_limit` levels deep, in post-order (deepest first, so leaves are
/// signalled before their parents).
///
/// `resolve` reads a candidate's identity through a pinned handle. It is called
/// at most once per pid, only for candidates whose snapshot parent is an
/// already selected process (or the root), and never for reserved or protected
/// pids.
///
/// Returns both the selected PIDs and a `complete` flag. If `complete` is
/// false, some candidates in the descent chain could not be resolved, so the
/// result is incomplete and should not be treated as a proven baseline.
pub fn owned_descendants(
	root_pid: u32,
	root_creation_time: u64,
	snapshot: &[SnapshotEntry],
	protected: &HashSet<u32>,
	depth_limit: usize,
	mut resolve: impl FnMut(u32) -> Option<PinnedIdentity>,
) -> OwnedDescendantsResult {
	struct Frame {
		pid:           u32,
		creation_time: u64,
		depth:         usize,
		next_child:    usize,
	}

	let mut children: HashMap<u32, Vec<SnapshotEntry>> = HashMap::new();
	for &entry in snapshot {
		children.entry(entry.parent_pid).or_default().push(entry);
	}

	let mut visited: HashSet<u32> = HashSet::from([root_pid]);
	let mut out = Vec::new();
	let mut complete = true;
	let mut stack = vec![Frame {
		pid:           root_pid,
		creation_time: root_creation_time,
		depth:         0,
		next_child:    0,
	}];
	while let Some(frame) = stack.last_mut() {
		let candidates = children.get(&frame.pid).map_or(&[][..], Vec::as_slice);
		if frame.depth >= depth_limit || frame.next_child >= candidates.len() {
			let finished = frame.pid;
			stack.pop();
			// The root is the only frame whose pop empties the stack; it is never
			// part of its own descendant set.
			if !stack.is_empty() {
				out.push(finished);
			}
			continue;
		}
		let candidate = candidates[frame.next_child];
		frame.next_child += 1;
		let (parent_pid, parent_creation_time, depth) = (frame.pid, frame.creation_time, frame.depth);
		if !visited.insert(candidate.pid)
			|| RESERVED_PIDS.contains(&candidate.pid)
			|| protected.contains(&candidate.pid)
		{
			continue;
		}
		let Some(identity) = resolve(candidate.pid) else {
			// A candidate in the descent chain could not be resolved. This means
			// the observation is incomplete: we cannot determine whether this
			// candidate is owned or not, so the baseline is unreliable.
			complete = false;
			continue;
		};
		if !is_owned_child(parent_pid, parent_creation_time, candidate, identity) {
			continue;
		}
		stack.push(Frame {
			pid:           candidate.pid,
			creation_time: identity.creation_time,
			depth:         depth + 1,
			next_child:    0,
		});
	}
	OwnedDescendantsResult { pids: out, complete }
}

/// The current process and every ancestor it can prove, for exclusion from all
/// walks.
///
/// Climbs parent numbers from the current process. A holder of the parent
/// number is treated as an ancestor when it was created no later than the
/// child it is checked against; an equal timestamp is protected as well because
/// protection, unlike selection, must err towards sparing. The climb stops at a
/// reserved pid, an unreadable process, or a holder created later than the
/// child (the real ancestor is gone and its number was reused).
pub fn protected_lineage(
	self_pid: u32,
	self_identity: Option<PinnedIdentity>,
	mut resolve: impl FnMut(u32) -> Option<PinnedIdentity>,
) -> HashSet<u32> {
	let mut protected = HashSet::from([self_pid]);
	let Some(mut current) = self_identity else {
		return protected;
	};
	loop {
		let parent_pid = current.parent_pid;
		if RESERVED_PIDS.contains(&parent_pid) || protected.contains(&parent_pid) {
			return protected;
		}
		let Some(parent) = resolve(parent_pid) else {
			return protected;
		};
		if parent.creation_time > current.creation_time {
			return protected;
		}
		protected.insert(parent_pid);
		current = parent;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const fn entry(pid: u32, parent_pid: u32) -> SnapshotEntry {
		SnapshotEntry { pid, parent_pid }
	}

	const fn live(parent_pid: u32, creation_time: u64) -> PinnedIdentity {
		PinnedIdentity { parent_pid, creation_time, running: true }
	}

	struct Table {
		snapshot:   Vec<SnapshotEntry>,
		identities: HashMap<u32, PinnedIdentity>,
	}

	impl Table {
		fn new() -> Self {
			Self { snapshot: Vec::new(), identities: HashMap::new() }
		}

		/// A process whose snapshot row and pinned identity agree.
		fn process(mut self, pid: u32, parent_pid: u32, creation_time: u64) -> Self {
			self.snapshot.push(entry(pid, parent_pid));
			self.identities.insert(pid, live(parent_pid, creation_time));
			self
		}

		fn walk(&self, root_pid: u32, root_creation_time: u64, protected: &HashSet<u32>) -> Vec<u32> {
			self
				.walk_result(root_pid, root_creation_time, protected, usize::MAX)
				.pids
		}

		fn walk_result(
			&self,
			root_pid: u32,
			root_creation_time: u64,
			protected: &HashSet<u32>,
			depth_limit: usize,
		) -> OwnedDescendantsResult {
			owned_descendants(
				root_pid,
				root_creation_time,
				&self.snapshot,
				protected,
				depth_limit,
				|pid| self.identities.get(&pid).copied(),
			)
		}

		fn walk_limited(
			&self,
			root_pid: u32,
			root_creation_time: u64,
			protected: &HashSet<u32>,
			depth_limit: usize,
		) -> Vec<u32> {
			self
				.walk_result(root_pid, root_creation_time, protected, depth_limit)
				.pids
		}
	}

	#[test]
	fn genuine_children_are_selected_leaves_first() {
		let table = Table::new()
			.process(10, 1, 1_000)
			.process(11, 10, 1_100)
			.process(12, 11, 1_200)
			.process(13, 10, 1_150);
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), vec![12, 11, 13]);
	}

	#[test]
	fn recycled_parent_number_does_not_adopt_an_older_orphan() {
		// Root 100 was created at t=5000 and holds a number that once belonged to
		// the dead creator of 200 (created at t=500) and its child 201.
		let table = Table::new()
			.process(100, 1, 5_000)
			.process(200, 100, 500)
			.process(201, 200, 600);
		assert_eq!(table.walk(100, 5_000, &HashSet::new()), Vec::<u32>::new());
	}

	#[test]
	fn orphaned_broker_with_reused_parent_number_keeps_its_whole_tree() {
		// Broker 7000 was started through a hop whose number 42 is now held by a
		// retained command process. Its session hosts and their commands are older
		// than the holder and must all be spared; the holder's own child is not.
		let table = Table::new()
			.process(42, 9, 9_000)
			.process(7000, 42, 1_000)
			.process(7001, 7000, 2_000)
			.process(7002, 7000, 2_100)
			.process(7100, 7001, 8_500)
			.process(43, 42, 9_100);
		assert_eq!(table.walk(42, 9_000, &HashSet::new()), vec![43]);
	}

	#[test]
	fn deep_chain_is_walked_without_recursion() {
		// Starts above the reserved pids so every link is a valid candidate.
		const ROOT: u32 = 1_000;
		const DEPTH: u32 = 50_000;
		let mut table = Table::new();
		for pid in ROOT..ROOT + DEPTH {
			table = table.process(pid + 1, pid, u64::from(pid + 1) * 10);
		}
		let selected = table.walk(ROOT, u64::from(ROOT) * 10, &HashSet::new());
		let expected: Vec<u32> = (ROOT + 1..=ROOT + DEPTH).rev().collect();
		assert_eq!(selected, expected);
	}

	#[test]
	fn deep_chain_stops_at_the_first_unproven_link() {
		let table = Table::new()
			.process(102, 101, 20)
			.process(103, 102, 30)
			.process(104, 103, 30) // equal to its parent: not proven
			.process(105, 104, 50);
		assert_eq!(table.walk(101, 10, &HashSet::new()), vec![103, 102]);
	}

	#[test]
	fn equal_creation_time_is_not_ownership() {
		let table = Table::new().process(20, 10, 1_000).process(21, 20, 2_000);
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), Vec::<u32>::new());
	}

	#[test]
	fn pid_reused_between_snapshot_and_open_is_rejected() {
		// The snapshot still shows 30 as a child of 10, but by the time 30 is
		// opened the number belongs to an unrelated, newer process.
		let mut table = Table::new().process(30, 10, 1_500).process(31, 30, 1_600);
		table.identities.insert(30, live(77, 1_700));
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), Vec::<u32>::new());
	}

	#[test]
	fn process_created_after_the_snapshot_is_left_for_the_next_wave() {
		// 32 exists and is genuinely owned, but it is absent from the snapshot the
		// walk was given, so this wave cannot see it.
		let mut table = Table::new().process(31, 10, 1_100);
		table.identities.insert(32, live(10, 1_200));
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), vec![31]);
	}

	#[test]
	fn unreadable_candidate_is_neither_selected_nor_walked_through() {
		let mut table = Table::new().process(40, 10, 1_100).process(41, 40, 1_200);
		table.identities.remove(&40);
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), Vec::<u32>::new());
	}

	#[test]
	fn exited_candidate_is_neither_selected_nor_walked_through() {
		let mut table = Table::new().process(40, 10, 1_100).process(41, 40, 1_200);
		table.identities.insert(40, PinnedIdentity {
			parent_pid:    10,
			creation_time: 1_100,
			running:       false,
		});
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), Vec::<u32>::new());
	}

	#[test]
	fn reserved_pids_are_denied_without_being_opened() {
		let table = Table::new().process(0, 10, 1_100).process(4, 10, 1_200);
		let mut opened = Vec::new();
		let result =
			owned_descendants(10, 1_000, &table.snapshot, &HashSet::new(), usize::MAX, |pid| {
				opened.push(pid);
				table.identities.get(&pid).copied()
			});
		assert_eq!(result.pids, Vec::<u32>::new());
		assert!(result.complete);
		assert_eq!(opened, Vec::<u32>::new());
	}

	#[test]
	fn current_process_and_its_subtree_are_never_selected() {
		// 50 genuinely belongs to the root, 60 is the current process (also
		// genuinely below the root), 61 is the current process's own child.
		let table = Table::new()
			.process(50, 10, 1_100)
			.process(60, 50, 1_200)
			.process(61, 60, 1_300);
		let protected = HashSet::from([60]);
		assert_eq!(table.walk(10, 1_000, &protected), vec![50]);
	}

	#[test]
	fn ancestor_reached_through_a_reused_number_is_protected() {
		// Even if an ancestor's creation order looked plausible, the protected
		// set excludes it and everything below it.
		let table = Table::new()
			.process(7000, 42, 9_500)
			.process(60, 7000, 9_600);
		let protected = HashSet::from([60, 7000]);
		assert_eq!(table.walk(42, 9_000, &protected), Vec::<u32>::new());
	}

	#[test]
	fn depth_limit_one_returns_direct_children_only() {
		let table = Table::new().process(11, 10, 1_100).process(12, 11, 1_200);
		assert_eq!(table.walk_limited(10, 1_000, &HashSet::new(), 1), vec![11]);
	}

	#[test]
	fn snapshot_cycles_terminate() {
		// Corrupt input: the root appears as its own grandchild.
		let table = Table::new().process(11, 10, 1_100).process(10, 11, 1_200);
		assert_eq!(table.walk(10, 1_000, &HashSet::new()), vec![11]);
	}

	#[test]
	fn lineage_climbs_older_ancestors_and_stops_at_a_reused_number() {
		let identities = HashMap::from([
			(40, live(30, 800)),
			(30, live(20, 950)), // number 30 now held by a process newer than 40
			(20, live(4, 100)),
		]);
		let lineage = protected_lineage(50, Some(live(40, 900)), |pid| identities.get(&pid).copied());
		assert_eq!(lineage, HashSet::from([50, 40]));
	}

	#[test]
	fn lineage_protects_equal_timestamps_and_stops_at_reserved_pids() {
		let identities = HashMap::from([(40, live(30, 900)), (30, live(4, 100))]);
		let lineage = protected_lineage(50, Some(live(40, 900)), |pid| identities.get(&pid).copied());
		assert_eq!(lineage, HashSet::from([50, 40, 30]));
	}

	#[test]
	fn lineage_without_self_identity_protects_self_only() {
		let lineage = protected_lineage(50, None, |_| Some(live(1, 1)));
		assert_eq!(lineage, HashSet::from([50]));
	}

	#[test]
	fn resolution_failure_marks_observation_incomplete() {
		// Regression test for issue #7765: when a candidate's identity cannot be
		// resolved during the descent chain, the observation must be marked
		// incomplete, not treated as a proven baseline.
		// First observation: candidate 11 cannot be resolved (transient failure).
		let mut table = Table::new().process(10, 1, 1_000).process(11, 10, 1_100);
		table.identities.remove(&11); // Simulate transient resolution failure
		let result = table.walk_result(10, 1_000, &HashSet::new(), usize::MAX);
		// The walk should return empty PIDs and mark the observation as incomplete.
		assert_eq!(result.pids, Vec::<u32>::new());
		assert!(!result.complete, "observation should be incomplete when identity resolution fails");

		// Second observation: after recovery, the identity is available.
		table.identities.insert(11, live(10, 1_100));
		let result = table.walk_result(10, 1_000, &HashSet::new(), usize::MAX);
		// Now we should have the complete descent tree and it should be marked
		// complete.
		assert_eq!(result.pids, vec![11]);
		assert!(result.complete, "observation should be complete after recovery");
	}

	#[test]
	fn resolution_failure_in_deep_chain_marks_incomplete() {
		// If a resolution failure occurs deep in the descent chain, the entire
		// observation should be marked incomplete.
		let mut table = Table::new()
			.process(10, 1, 1_000)
			.process(11, 10, 1_100)
			.process(12, 11, 1_200);
		// Remove 12's identity to simulate transient failure
		table.identities.remove(&12);
		let result = table.walk_result(10, 1_000, &HashSet::new(), usize::MAX);
		// We should have 11 because it was successfully resolved, but the
		// observation should be incomplete because 12 failed.
		assert_eq!(result.pids, vec![11]);
		assert!(!result.complete, "observation should be incomplete due to failure in descent chain");
	}

	#[test]
	fn skipped_branches_do_not_affect_completeness() {
		// If a candidate is skipped for a valid reason (not owned, is protected,
		// etc.), the observation should still be complete as long as all
		// candidates in the actual descent path are resolved.
		let mut table = Table::new()
			.process(10, 1, 1_000)
			.process(11, 10, 1_100)
			.process(20, 1, 1_050) // Unrelated to 10
			.process(21, 20, 1_150);
		// Remove 20's identity so it cannot be descended into, but this doesn't
		// affect the descent from 10.
		table.identities.remove(&20);
		let result = table.walk_result(10, 1_000, &HashSet::new(), usize::MAX);
		// The descent from 10 should be complete despite 20 being unresolvable.
		assert_eq!(result.pids, vec![11]);
		assert!(
			result.complete,
			"observation should be complete when unresolvable pids are outside the descent path"
		);
	}
}
