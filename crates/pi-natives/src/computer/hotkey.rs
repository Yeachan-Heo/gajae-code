//! Global kill-switch hotkey listener (macOS).
//!
//! Runs a listen-only `CGEventTap` for key-down events on a dedicated thread
//! that owns its own `CFRunLoop`. When the configured hotkey
//! (Control+Option+Command+Escape by default) is seen, it latches
//! [`Supervisor::trigger_stop`] on the process-global supervisor — independent
//! of the model's tool path, so the model cannot bypass it.
//!
//! The listener marks the supervisor's stop path live on successful tap
//! creation and clears it on teardown, so input gating fails closed if the tap
//! cannot start. Verified by a synthetic-injection self-test (post the hotkey,
//! observe the latch) plus a real key press by a human for the final drill.

use std::{
	ffi::c_void,
	sync::OnceLock,
	thread,
	time::{Duration, Instant},
};

use super::supervisor::Supervisor;

type CfMachPortRef = *mut c_void;
type CfRunLoopSourceRef = *mut c_void;
type CfRunLoopRef = *const c_void;
type CfAllocatorRef = *const c_void;
type CfStringRef = *const c_void;
type CgEventRef = *mut c_void;
type CgEventTapProxy = *mut c_void;
type CgEventTapCallBack = extern "C" fn(
	proxy: CgEventTapProxy,
	event_type: u32,
	event: CgEventRef,
	user_info: *mut c_void,
) -> CgEventRef;

// CGEventTap placement/options/location.
const SESSION_EVENT_TAP: u32 = 1; // kCGSessionEventTap
const HEAD_INSERT: u32 = 0; // kCGHeadInsertEventTap
const LISTEN_ONLY: u32 = 1; // kCGEventTapOptionListenOnly
const EVENT_KEY_DOWN: u32 = 10; // kCGEventKeyDown
const KEYCODE_FIELD: u32 = 9; // kCGKeyboardEventKeycode
const KEY_DOWN_MASK: u64 = 1 << EVENT_KEY_DOWN; // CGEventMaskBit(kCGEventKeyDown)

// Default hotkey: Control+Option+Command+Escape — distinctive, unlikely to
// collide.
const HOTKEY_KEYCODE: i64 = 53; // Escape
const FLAG_CONTROL: u64 = 0x0004_0000;
const FLAG_OPTION: u64 = 0x0008_0000;
const FLAG_COMMAND: u64 = 0x0010_0000;
const HOTKEY_MODS: u64 = FLAG_CONTROL | FLAG_OPTION | FLAG_COMMAND;

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	fn CGEventTapCreate(
		tap: u32,
		place: u32,
		options: u32,
		events_of_interest: u64,
		callback: CgEventTapCallBack,
		user_info: *mut c_void,
	) -> CfMachPortRef;
	fn CGEventTapEnable(tap: CfMachPortRef, enable: bool);
	fn CGEventGetIntegerValueField(event: CgEventRef, field: u32) -> i64;
	fn CGEventGetFlags(event: CgEventRef) -> u64;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	static kCFRunLoopCommonModes: CfStringRef;
	fn CFMachPortCreateRunLoopSource(
		allocator: CfAllocatorRef,
		port: CfMachPortRef,
		order: isize,
	) -> CfRunLoopSourceRef;
	fn CFRunLoopGetCurrent() -> CfRunLoopRef;
	fn CFRunLoopAddSource(rl: CfRunLoopRef, source: CfRunLoopSourceRef, mode: CfStringRef);
	fn CFRunLoopRun();
	fn CFRelease(cf: *const c_void);
}

const fn matches_hotkey(keycode: i64, flags: u64) -> bool {
	keycode == HOTKEY_KEYCODE && (flags & HOTKEY_MODS) == HOTKEY_MODS
}

extern "C" fn tap_callback(
	_proxy: CgEventTapProxy,
	event_type: u32,
	event: CgEventRef,
	_user_info: *mut c_void,
) -> CgEventRef {
	if event_type == EVENT_KEY_DOWN && !event.is_null() {
		// SAFETY: `event` is a valid key event provided by the tap for the
		// duration of this callback; we only read fields and return it unchanged.
		let (keycode, flags) =
			unsafe { (CGEventGetIntegerValueField(event, KEYCODE_FIELD), CGEventGetFlags(event)) };
		if matches_hotkey(keycode, flags) {
			Supervisor::global().trigger_stop();
		}
	}
	// Listen-only: pass the event through untouched.
	event
}

static STARTED: OnceLock<bool> = OnceLock::new();

/// Start the global hotkey listener once (idempotent).
///
/// Spawns a dedicated `CFRunLoop` thread; on successful tap creation the
/// supervisor's stop path is marked live. Returns whether the listener is
/// (now) live.
pub fn start() -> bool {
	let first = STARTED.set(true).is_ok();
	if first {
		thread::Builder::new()
			.name("computer-killswitch".into())
			.spawn(run_listener)
			.ok();
	}
	wait_until_live(Duration::from_secs(1))
}

fn run_listener() {
	// SAFETY: a listen-only key-down session tap; the returned mach port and
	// run-loop source are added to this thread's run loop, which then runs for
	// the process lifetime. Handles are released only on the (non-returning)
	// teardown path below.
	unsafe {
		let tap = CGEventTapCreate(
			SESSION_EVENT_TAP,
			HEAD_INSERT,
			LISTEN_ONLY,
			KEY_DOWN_MASK,
			tap_callback,
			std::ptr::null_mut(),
		);
		if tap.is_null() {
			Supervisor::global().set_hotkey_live(false);
			return;
		}
		let source = CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
		if source.is_null() {
			CFRelease(tap.cast_const());
			Supervisor::global().set_hotkey_live(false);
			return;
		}
		CFRunLoopAddSource(CFRunLoopGetCurrent(), source, kCFRunLoopCommonModes);
		CGEventTapEnable(tap, true);
		Supervisor::global().set_hotkey_live(true);
		CFRunLoopRun();
		// Unreached in normal operation; if the run loop ever returns, fail closed.
		Supervisor::global().set_hotkey_live(false);
		CFRelease(source.cast_const());
		CFRelease(tap.cast_const());
	}
}

fn wait_until_live(timeout: Duration) -> bool {
	let deadline = Instant::now() + timeout;
	loop {
		if Supervisor::global().status().hotkey_live {
			return true;
		}
		if Instant::now() >= deadline {
			return false;
		}
		thread::sleep(Duration::from_millis(20));
	}
}

#[cfg(test)]
mod tests {
	use super::{HOTKEY_KEYCODE, HOTKEY_MODS, matches_hotkey};

	#[test]
	fn matches_only_the_full_hotkey_combo() {
		assert!(matches_hotkey(HOTKEY_KEYCODE, HOTKEY_MODS));
		assert!(matches_hotkey(HOTKEY_KEYCODE, HOTKEY_MODS | 0x1)); // extra bits ok
		assert!(!matches_hotkey(HOTKEY_KEYCODE, 0)); // no modifiers
		assert!(!matches_hotkey(HOTKEY_KEYCODE, 0x0004_0000)); // only control
		assert!(!matches_hotkey(0, HOTKEY_MODS)); // wrong key
	}
}

#[cfg(all(test, target_os = "macos"))]
mod live_tests {
	use std::{ffi::c_void, thread, time::Duration};

	use super::{HOTKEY_KEYCODE, HOTKEY_MODS, start};
	use crate::computer::{permissions::accessibility_granted, supervisor::Supervisor};

	type CgEventSourceRef = *mut c_void;
	type CgEventRef = *mut c_void;

	#[link(name = "CoreGraphics", kind = "framework")]
	unsafe extern "C" {
		fn CGEventSourceCreate(state_id: u32) -> CgEventSourceRef;
		fn CGEventCreateKeyboardEvent(
			source: CgEventSourceRef,
			keycode: u16,
			key_down: bool,
		) -> CgEventRef;
		fn CGEventSetFlags(event: CgEventRef, flags: u64);
		fn CGEventPost(tap: u32, event: CgEventRef);
		fn CFRelease(cf: *const c_void);
	}

	fn post_hotkey() {
		// SAFETY: creates, flags, posts, and releases a synthetic key event.
		unsafe {
			let source = CGEventSourceCreate(0);
			for down in [true, false] {
				let event = CGEventCreateKeyboardEvent(source, HOTKEY_KEYCODE as u16, down);
				if event.is_null() {
					continue;
				}
				CGEventSetFlags(event, HOTKEY_MODS);
				CGEventPost(0, event);
				CFRelease(event.cast_const());
			}
			if !source.is_null() {
				CFRelease(source.cast_const());
			}
		}
	}

	/// Starts the listener and posts a synthetic hotkey, proving the tap latches
	/// the supervisor. Requires Accessibility/Input-Monitoring; ignored by
	/// default.
	#[test]
	#[ignore = "starts a global event tap and posts a synthetic hotkey; needs macOS + grants"]
	fn synthetic_hotkey_triggers_stop() {
		assert!(accessibility_granted(), "Accessibility must be granted");
		let live = start();
		assert!(live, "hotkey listener should report live (tap created)");

		Supervisor::global().reset();
		assert!(!Supervisor::global().is_suspended());

		post_hotkey();
		// Give the tap callback time to fire on its run-loop thread.
		for _ in 0..50 {
			if Supervisor::global().is_suspended() {
				break;
			}
			thread::sleep(Duration::from_millis(20));
		}
		assert!(Supervisor::global().is_suspended(), "synthetic hotkey should latch trigger_stop");
		Supervisor::global().reset();
	}
}
