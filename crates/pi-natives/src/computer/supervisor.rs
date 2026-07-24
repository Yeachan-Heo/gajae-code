//! Process-global kill-switch supervisor for computer-use.
//!
//! # Role
//! The supervisor is the safety authority for autonomous input: side-effecting
//! actions may fire only while [`Supervisor::input_allowed`] holds, and a stop
//! (global hotkey or TUI key) latches [`Supervisor::is_suspended`] until a
//! **user-only** [`Supervisor::reset`]. The model-facing surface can never
//! reset suspension.
//!
//! `input_allowed` is fail-closed: it requires the stop path to be live
//! (`hotkey_live`), a fresh heartbeat from that stop path, and a non-suspended
//! state. If the hotkey listener dies (heartbeat goes stale or liveness drops),
//! input is disabled automatically.
//!
//! This module is pure state (atomics + timestamps) so the safety logic is
//! unit-tested deterministically without OS event taps; the OS hotkey listener
//! (a `CFRunLoop` `CGEventTap`) drives
//! `set_hotkey_live`/`heartbeat`/`trigger_stop` and is verified separately.

use std::{
	sync::{
		OnceLock,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

/// Max age of the stop-path heartbeat before input is disabled (ms).
pub const HEARTBEAT_FRESH_MS: u64 = 2_000;

/// Snapshot of supervisor state used for gating and status reporting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorStatus {
	/// Input is latched off until a user-only reset.
	pub suspended: bool,
	/// The global stop path (hotkey/event-tap) reports itself live.
	pub hotkey_live: bool,
	/// The stop path's heartbeat is within [`HEARTBEAT_FRESH_MS`].
	pub heartbeat_fresh: bool,
}

impl SupervisorStatus {
	/// Whether side-effecting input may fire: live, fresh, and not suspended.
	#[must_use]
	pub const fn input_allowed(self) -> bool {
		self.hotkey_live && self.heartbeat_fresh && !self.suspended
	}
}

/// Process-global kill-switch state.
pub struct Supervisor {
	suspended: AtomicBool,
	hotkey_live: AtomicBool,
	last_heartbeat_ms: AtomicU64,
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
}

impl Supervisor {
	/// Construct a fresh supervisor: not suspended, stop path not yet live.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			suspended: AtomicBool::new(false),
			hotkey_live: AtomicBool::new(false),
			last_heartbeat_ms: AtomicU64::new(0),
		}
	}

	/// The process-global supervisor singleton.
	pub fn global() -> &'static Self {
		static GLOBAL: OnceLock<Supervisor> = OnceLock::new();
		GLOBAL.get_or_init(Self::new)
	}

	/// Record that the stop path is live (or not) and refresh its heartbeat.
	pub fn set_hotkey_live(&self, live: bool) {
		self.hotkey_live.store(live, Ordering::SeqCst);
		if live {
			self.last_heartbeat_ms.store(now_ms(), Ordering::SeqCst);
		}
	}

	/// Heartbeat from the live stop path (call on a fixed interval).
	pub fn heartbeat(&self) {
		self.heartbeat_at(now_ms());
	}

	/// Heartbeat with an explicit timestamp (deterministic in tests).
	pub fn heartbeat_at(&self, at_ms: u64) {
		self.last_heartbeat_ms.store(at_ms, Ordering::SeqCst);
	}

	/// Latch suspension: abort further input until a user-only [`reset`].
	/// Invoked by the global hotkey or TUI stop key.
	///
	/// [`reset`]: Supervisor::reset
	pub fn trigger_stop(&self) {
		self.suspended.store(true, Ordering::SeqCst);
	}

	/// Clear suspension. **User-only** — never wire this to the model-facing
	/// tool schema or generic tool dispatch.
	pub fn reset(&self) {
		self.suspended.store(false, Ordering::SeqCst);
	}

	/// Whether input is currently latched off.
	#[must_use]
	pub fn is_suspended(&self) -> bool {
		self.suspended.load(Ordering::SeqCst)
	}

	/// Status as of `now_ms` (explicit for tests).
	#[must_use]
	pub fn status_at(&self, now_ms: u64) -> SupervisorStatus {
		let last = self.last_heartbeat_ms.load(Ordering::SeqCst);
		SupervisorStatus {
			suspended: self.suspended.load(Ordering::SeqCst),
			hotkey_live: self.hotkey_live.load(Ordering::SeqCst),
			heartbeat_fresh: now_ms.saturating_sub(last) <= HEARTBEAT_FRESH_MS,
		}
	}

	/// Status as of now.
	#[must_use]
	pub fn status(&self) -> SupervisorStatus {
		self.status_at(now_ms())
	}

	/// Whether side-effecting input may fire right now.
	#[must_use]
	pub fn input_allowed(&self) -> bool {
		self.status().input_allowed()
	}
}

impl Default for Supervisor {
	fn default() -> Self {
		Self::new()
	}
}

#[cfg(test)]
mod tests {
	use super::{HEARTBEAT_FRESH_MS, Supervisor};

	#[test]
	fn fresh_supervisor_disallows_input_until_stop_path_is_live() {
		let s = Supervisor::new();
		assert!(!s.status_at(1_000).input_allowed(), "not live yet");
		assert!(!s.is_suspended());
	}

	#[test]
	fn live_and_fresh_allows_input() {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat_at(10_000);
		assert!(s.status_at(10_500).input_allowed());
	}

	#[test]
	fn stale_heartbeat_disables_input() {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat_at(10_000);
		let stale = 10_000 + HEARTBEAT_FRESH_MS + 1;
		assert!(!s.status_at(stale).input_allowed(), "stale heartbeat must fail closed");
	}

	#[test]
	fn trigger_stop_latches_until_user_reset() {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat_at(10_000);
		assert!(s.status_at(10_100).input_allowed());

		s.trigger_stop();
		assert!(s.is_suspended());
		// Even with a live, fresh stop path, suspension keeps input off.
		s.heartbeat_at(10_200);
		assert!(!s.status_at(10_250).input_allowed());

		s.reset();
		assert!(!s.is_suspended());
		s.heartbeat_at(10_300);
		assert!(s.status_at(10_350).input_allowed());
	}

	#[test]
	fn losing_hotkey_liveness_disables_input() {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat_at(10_000);
		assert!(s.status_at(10_100).input_allowed());
		s.set_hotkey_live(false);
		assert!(!s.status_at(10_150).input_allowed(), "dead stop path must fail closed");
	}
}
