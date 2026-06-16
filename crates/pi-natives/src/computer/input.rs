//! macOS native input injection for computer-use.
//!
//! # Safety model
//! Input is **runtime-gated**: [`InputController::guarded`] refuses to
//! construct unless Accessibility is granted (see [`super::permissions`]), so
//! no event can be posted while the TCC gate is closed. This module is also
//! **not** wired to napi or the model surface yet — per the approved plan,
//! input is exposed only after the kill-switch supervisor is proven live.
//!
//! # Testability
//! All event *orchestration* (action → low-level event sequence, held
//! button/modifier tracking, coordinate transforms, release-all cleanup) lives
//! in [`InputController`] over an [`EventSink`] trait. Unit tests drive a
//! [`RecordingSink`] to assert exact sequences without posting real OS events.
//! Only [`MacEventSink`] performs `CGEvent` FFI; its live behavior is verified
//! in a granted `gjc` session, not from a non-TCC-trusted test binary.

use super::coords::{CoordError, LogicalPoint, NormalizedDisplay};

/// A mouse button.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MouseButton {
	/// Primary (left) button.
	Left,
	/// Secondary (right) button.
	Right,
	/// Tertiary (middle) button.
	Center,
}

/// One low-level event recorded by [`RecordingSink`] for tests.
#[derive(Debug, Clone, PartialEq)]
pub enum SinkOp {
	/// Move the cursor to a logical point.
	Move(LogicalPoint),
	/// Press or release `button` at a logical point.
	Button { at: LogicalPoint, button: MouseButton, down: bool },
	/// Scroll by logical deltas (`dx`, `dy`).
	Scroll { dx: f64, dy: f64 },
	/// Type a unicode string.
	TypeUnicode(String),
	/// Press or release a virtual key code.
	Key { code: u16, down: bool },
}

/// Sink for low-level input events. The real implementation posts `CGEvent`s;
/// the test implementation records them.
pub trait EventSink {
	/// Move the cursor.
	fn move_cursor(&mut self, to: LogicalPoint);
	/// Press or release a mouse button at a point.
	fn mouse_button(&mut self, at: LogicalPoint, button: MouseButton, down: bool);
	/// Scroll by logical deltas.
	fn scroll(&mut self, dx: f64, dy: f64);
	/// Type a unicode string.
	fn type_unicode(&mut self, text: &str);
	/// Press or release a virtual key code.
	fn key(&mut self, code: u16, down: bool);
}

/// Error from an input action.
#[derive(Debug, Clone, PartialEq)]
pub enum InputError {
	/// A coordinate could not be mapped to a logical point.
	Coord(CoordError),
	/// A key name was not recognized.
	UnknownKey(String),
}

impl From<CoordError> for InputError {
	fn from(value: CoordError) -> Self {
		Self::Coord(value)
	}
}

impl std::fmt::Display for InputError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Coord(err) => write!(f, "{err}"),
			Self::UnknownKey(key) => write!(f, "unknown key name: {key}"),
		}
	}
}

impl std::error::Error for InputError {}

/// Resolve a named key (or single character) to a macOS virtual key code.
/// Returns `None` for unrecognized names.
#[must_use]
pub fn key_code_for(name: &str) -> Option<u16> {
	let code = match name.to_ascii_lowercase().as_str() {
		"return" | "enter" => 36,
		"tab" => 48,
		"space" => 49,
		"delete" | "backspace" => 51,
		"escape" | "esc" => 53,
		"left" | "arrowleft" => 123,
		"right" | "arrowright" => 124,
		"down" | "arrowdown" => 125,
		"up" | "arrowup" => 126,
		_ => return None,
	};
	Some(code)
}

/// Orchestrates input actions over an [`EventSink`], tracking held buttons so
/// [`InputController::release_all`] can clean up after an abort or error.
pub struct InputController<S: EventSink> {
	sink:         S,
	cursor:       LogicalPoint,
	held_buttons: Vec<MouseButton>,
}

impl<S: EventSink> InputController<S> {
	/// Construct a controller over `sink`. Prefer [`InputController::guarded`]
	/// for any path that posts real events.
	pub const fn new(sink: S) -> Self {
		Self { sink, cursor: LogicalPoint { x: 0.0, y: 0.0 }, held_buttons: Vec::new() }
	}

	/// The most recent cursor position.
	#[must_use]
	pub const fn cursor(&self) -> LogicalPoint {
		self.cursor
	}

	/// Whether any mouse button is currently held.
	#[must_use]
	pub const fn has_held_buttons(&self) -> bool {
		!self.held_buttons.is_empty()
	}

	/// Consume the controller and return the underlying sink (e.g. to inspect
	/// recorded events in tests).
	#[must_use]
	pub fn into_sink(self) -> S {
		self.sink
	}

	fn press(&mut self, at: LogicalPoint, button: MouseButton) {
		self.sink.mouse_button(at, button, true);
		if !self.held_buttons.contains(&button) {
			self.held_buttons.push(button);
		}
	}

	fn release(&mut self, at: LogicalPoint, button: MouseButton) {
		self.sink.mouse_button(at, button, false);
		self.held_buttons.retain(|held| *held != button);
	}

	/// Move the cursor to a screenshot-space pixel on `display`.
	///
	/// # Errors
	/// Returns [`InputError::Coord`] when the pixel is out of bounds.
	pub fn move_to(
		&mut self,
		display: &NormalizedDisplay,
		x: f64,
		y: f64,
	) -> Result<(), InputError> {
		let point = display.to_logical_point(x, y)?;
		self.cursor = point;
		self.sink.move_cursor(point);
		Ok(())
	}

	/// Move to `(x, y)` and click `button`.
	///
	/// # Errors
	/// Returns [`InputError::Coord`] when the pixel is out of bounds.
	pub fn click(
		&mut self,
		display: &NormalizedDisplay,
		x: f64,
		y: f64,
		button: MouseButton,
	) -> Result<(), InputError> {
		self.move_to(display, x, y)?;
		let at = self.cursor;
		self.press(at, button);
		self.release(at, button);
		Ok(())
	}

	/// Double-click `button` at `(x, y)`.
	///
	/// # Errors
	/// Returns [`InputError::Coord`] when the pixel is out of bounds.
	pub fn double_click(
		&mut self,
		display: &NormalizedDisplay,
		x: f64,
		y: f64,
		button: MouseButton,
	) -> Result<(), InputError> {
		self.click(display, x, y, button)?;
		let at = self.cursor;
		self.press(at, button);
		self.release(at, button);
		Ok(())
	}

	/// Press at `(from_x, from_y)`, drag to `(to_x, to_y)`, and release.
	/// Releases the button on the error path so no button is left held.
	///
	/// # Errors
	/// Returns [`InputError::Coord`] when either pixel is out of bounds.
	pub fn drag(
		&mut self,
		display: &NormalizedDisplay,
		from_x: f64,
		from_y: f64,
		to_x: f64,
		to_y: f64,
		button: MouseButton,
	) -> Result<(), InputError> {
		self.move_to(display, from_x, from_y)?;
		let start = self.cursor;
		self.press(start, button);
		match display.to_logical_point(to_x, to_y) {
			Ok(end) => {
				self.cursor = end;
				self.sink.move_cursor(end);
				self.release(end, button);
				Ok(())
			},
			Err(err) => {
				// Out-of-bounds destination: release the held button before erroring.
				self.release(start, button);
				Err(InputError::Coord(err))
			},
		}
	}

	/// Scroll by logical deltas after moving to `(x, y)`.
	///
	/// # Errors
	/// Returns [`InputError::Coord`] when the pixel is out of bounds.
	pub fn scroll(
		&mut self,
		display: &NormalizedDisplay,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
	) -> Result<(), InputError> {
		self.move_to(display, x, y)?;
		self.sink.scroll(dx, dy);
		Ok(())
	}

	/// Type a unicode string.
	pub fn type_text(&mut self, text: &str) {
		self.sink.type_unicode(text);
	}

	/// Press and release each named key in order.
	///
	/// # Errors
	/// Returns [`InputError::UnknownKey`] when a name is unrecognized; keys
	/// before the failure have already been sent.
	pub fn keypress(&mut self, keys: &[String]) -> Result<(), InputError> {
		for name in keys {
			let code = key_code_for(name).ok_or_else(|| InputError::UnknownKey(name.clone()))?;
			self.sink.key(code, true);
			self.sink.key(code, false);
		}
		Ok(())
	}

	/// Release every held mouse button (idempotent). Run on abort/error paths
	/// so a partial drag never leaves a button stuck.
	pub fn release_all(&mut self) {
		let at = self.cursor;
		let held: Vec<MouseButton> = self.held_buttons.drain(..).collect();
		for button in held {
			self.sink.mouse_button(at, button, false);
		}
	}
}

#[cfg(target_os = "macos")]
pub use mac::{MacEventSink, current_cursor_position, guarded_controller};

#[cfg(target_os = "macos")]
mod mac {
	//! Real CGEvent-backed [`EventSink`] (macOS). Live behavior is verified in a
	//! granted `gjc` session; construction is gated on Accessibility.

	use std::ffi::c_void;

	use super::{EventSink, InputController, MouseButton};
	use crate::computer::{
		coords::LogicalPoint,
		permissions::{PermissionError, require_accessibility_for_input},
	};

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct CgPoint {
		x: f64,
		y: f64,
	}

	type CgEventSourceRef = *mut c_void;
	type CgEventRef = *mut c_void;

	// CGEventType values.
	const LEFT_DOWN: u32 = 1;
	const LEFT_UP: u32 = 2;
	const RIGHT_DOWN: u32 = 3;
	const RIGHT_UP: u32 = 4;
	const MOUSE_MOVED: u32 = 5;
	const OTHER_DOWN: u32 = 25;
	const OTHER_UP: u32 = 26;

	// CGMouseButton values.
	const BTN_LEFT: u32 = 0;
	const BTN_RIGHT: u32 = 1;
	const BTN_CENTER: u32 = 2;

	// kCGEventSourceStateCombinedSessionState / kCGHIDEventTap.
	const SOURCE_COMBINED_SESSION: u32 = 0;
	const HID_EVENT_TAP: u32 = 0;
	// kCGScrollEventUnitPixel.
	const SCROLL_UNIT_PIXEL: u32 = 0;

	#[link(name = "CoreGraphics", kind = "framework")]
	unsafe extern "C" {
		fn CGEventSourceCreate(state_id: u32) -> CgEventSourceRef;
		fn CGEventCreateMouseEvent(
			source: CgEventSourceRef,
			mouse_type: u32,
			position: CgPoint,
			button: u32,
		) -> CgEventRef;
		fn CGEventCreateScrollWheelEvent(
			source: CgEventSourceRef,
			units: u32,
			wheel_count: u32,
			wheel1: i32,
			// `CGEventCreateScrollWheelEvent` is C-variadic (wheel1, ...); wheel2/wheel3
			// are passed as varargs. Declaring fixed-arity is ABI-unsound on arm64.
			...
		) -> CgEventRef;
		fn CGEventCreateKeyboardEvent(
			source: CgEventSourceRef,
			keycode: u16,
			key_down: bool,
		) -> CgEventRef;
		fn CGEventKeyboardSetUnicodeString(event: CgEventRef, length: usize, string: *const u16);
		fn CGEventPost(tap: u32, event: CgEventRef);
		fn CGEventCreate(source: CgEventSourceRef) -> CgEventRef;
		fn CGEventGetLocation(event: CgEventRef) -> CgPoint;
		fn CGWarpMouseCursorPosition(new_cursor_position: CgPoint) -> i32;
		fn CFRelease(cf: *const c_void);
	}

	const fn button_codes(button: MouseButton, down: bool) -> (u32, u32) {
		match button {
			MouseButton::Left => (if down { LEFT_DOWN } else { LEFT_UP }, BTN_LEFT),
			MouseButton::Right => (if down { RIGHT_DOWN } else { RIGHT_UP }, BTN_RIGHT),
			MouseButton::Center => (if down { OTHER_DOWN } else { OTHER_UP }, BTN_CENTER),
		}
	}

	/// CGEvent-backed sink. Holds an event source for the session.
	pub struct MacEventSink {
		source: CgEventSourceRef,
	}

	impl MacEventSink {
		fn new() -> Self {
			// SAFETY: `CGEventSourceCreate` returns an owned source (or null,
			// which CGEvent creation tolerates); released on drop.
			let source = unsafe { CGEventSourceCreate(SOURCE_COMBINED_SESSION) };
			Self { source }
		}

		fn post_mouse(&self, at: LogicalPoint, event_type: u32, button: u32) {
			let position = CgPoint { x: at.x, y: at.y };
			// SAFETY: `source` is the owned event source; the created event is
			// posted and released exactly once.
			unsafe {
				let event = CGEventCreateMouseEvent(self.source, event_type, position, button);
				if !event.is_null() {
					CGEventPost(HID_EVENT_TAP, event);
					CFRelease(event.cast_const());
				}
			}
		}
	}

	impl Drop for MacEventSink {
		fn drop(&mut self) {
			if !self.source.is_null() {
				// SAFETY: `source` is owned, non-null, and not used after release.
				unsafe { CFRelease(self.source.cast_const()) };
			}
		}
	}

	impl EventSink for MacEventSink {
		fn move_cursor(&mut self, to: LogicalPoint) {
			// `CGWarpMouseCursorPosition` reliably relocates the hardware cursor
			// (a bare mouseMoved event does not); the moved event then notifies
			// apps of the hover at the new point.
			let position = CgPoint { x: to.x, y: to.y };
			// SAFETY: pure Core Graphics cursor warp to a point; no ownership.
			unsafe { CGWarpMouseCursorPosition(position) };
			self.post_mouse(to, MOUSE_MOVED, BTN_LEFT);
		}

		fn mouse_button(&mut self, at: LogicalPoint, button: MouseButton, down: bool) {
			let (event_type, code) = button_codes(button, down);
			self.post_mouse(at, event_type, code);
		}

		fn scroll(&mut self, dx: f64, dy: f64) {
			// SAFETY: created scroll event is posted and released exactly once.
			unsafe {
				let event = CGEventCreateScrollWheelEvent(
					self.source,
					SCROLL_UNIT_PIXEL,
					2,
					dy as i32,
					dx as i32,
				);
				if !event.is_null() {
					CGEventPost(HID_EVENT_TAP, event);
					CFRelease(event.cast_const());
				}
			}
		}

		fn type_unicode(&mut self, text: &str) {
			let utf16: Vec<u16> = text.encode_utf16().collect();
			// SAFETY: down/up keyboard events are created, populated with the
			// UTF-16 buffer (valid for the call), posted, and released once each.
			unsafe {
				for down in [true, false] {
					let event = CGEventCreateKeyboardEvent(self.source, 0, down);
					if event.is_null() {
						continue;
					}
					CGEventKeyboardSetUnicodeString(event, utf16.len(), utf16.as_ptr());
					CGEventPost(HID_EVENT_TAP, event);
					CFRelease(event.cast_const());
				}
			}
		}

		fn key(&mut self, code: u16, down: bool) {
			// SAFETY: created keyboard event is posted and released exactly once.
			unsafe {
				let event = CGEventCreateKeyboardEvent(self.source, code, down);
				if !event.is_null() {
					CGEventPost(HID_EVENT_TAP, event);
					CFRelease(event.cast_const());
				}
			}
		}
	}

	/// Construct an [`InputController`] backed by real `CGEvent`s — only when
	/// Accessibility is granted.
	///
	/// # Errors
	/// Returns [`PermissionError`] when Accessibility is not granted; no event
	/// source is created and no input can be posted.
	pub fn guarded_controller() -> Result<InputController<MacEventSink>, PermissionError> {
		require_accessibility_for_input()?;
		Ok(InputController::new(MacEventSink::new()))
	}

	/// Read the current global cursor position in logical points (top-left
	/// origin). Used to verify mouse-move injection without clicking.
	#[must_use]
	pub fn current_cursor_position() -> LogicalPoint {
		// SAFETY: `CGEventCreate(null)` returns an event whose location is the
		// current cursor; it is released after the read.
		unsafe {
			let event = CGEventCreate(std::ptr::null_mut());
			if event.is_null() {
				return LogicalPoint { x: 0.0, y: 0.0 };
			}
			let location = CGEventGetLocation(event);
			CFRelease(event.cast_const());
			LogicalPoint { x: location.x, y: location.y }
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{EventSink, InputController, InputError, MouseButton, SinkOp, key_code_for};
	use crate::computer::coords::{LogicalPoint, NormalizedDisplay};

	#[derive(Default)]
	struct RecordingSink {
		ops: Vec<SinkOp>,
	}

	impl EventSink for RecordingSink {
		fn move_cursor(&mut self, to: LogicalPoint) {
			self.ops.push(SinkOp::Move(to));
		}

		fn mouse_button(&mut self, at: LogicalPoint, button: MouseButton, down: bool) {
			self.ops.push(SinkOp::Button { at, button, down });
		}

		fn scroll(&mut self, dx: f64, dy: f64) {
			self.ops.push(SinkOp::Scroll { dx, dy });
		}

		fn type_unicode(&mut self, text: &str) {
			self.ops.push(SinkOp::TypeUnicode(text.to_string()));
		}

		fn key(&mut self, code: u16, down: bool) {
			self.ops.push(SinkOp::Key { code, down });
		}
	}

	fn display() -> NormalizedDisplay {
		// 200x100 physical px at 2x => clicks map to logical /2.
		NormalizedDisplay::new(200, 100, 2.0, 2.0, 0.0, 0.0)
	}

	#[test]
	fn click_moves_then_presses_and_releases_at_logical_point() {
		let mut c = InputController::new(RecordingSink::default());
		c.click(&display(), 100.0, 50.0, MouseButton::Left).unwrap();
		let at = LogicalPoint { x: 50.0, y: 25.0 };
		assert_eq!(c.into_ops(), vec![
			SinkOp::Move(at),
			SinkOp::Button { at, button: MouseButton::Left, down: true },
			SinkOp::Button { at, button: MouseButton::Left, down: false },
		]);
	}

	#[test]
	fn double_click_emits_two_press_release_pairs() {
		let mut c = InputController::new(RecordingSink::default());
		c.double_click(&display(), 10.0, 10.0, MouseButton::Left)
			.unwrap();
		let downs = c
			.ops_ref()
			.iter()
			.filter(|op| matches!(op, SinkOp::Button { down: true, .. }))
			.count();
		let ups = c
			.ops_ref()
			.iter()
			.filter(|op| matches!(op, SinkOp::Button { down: false, .. }))
			.count();
		assert_eq!((downs, ups), (2, 2));
		assert!(!c.has_held_buttons());
	}

	#[test]
	fn drag_releases_button_and_leaves_none_held() {
		let mut c = InputController::new(RecordingSink::default());
		c.drag(&display(), 0.0, 0.0, 100.0, 50.0, MouseButton::Left)
			.unwrap();
		assert!(!c.has_held_buttons());
		let ops = c.into_ops();
		assert_eq!(ops.first(), Some(&SinkOp::Move(LogicalPoint { x: 0.0, y: 0.0 })));
		assert_eq!(
			ops.last(),
			Some(&SinkOp::Button {
				at:     LogicalPoint { x: 50.0, y: 25.0 },
				button: MouseButton::Left,
				down:   false,
			})
		);
	}

	#[test]
	fn drag_to_out_of_bounds_releases_the_held_button() {
		let mut c = InputController::new(RecordingSink::default());
		let err = c
			.drag(&display(), 0.0, 0.0, 999.0, 0.0, MouseButton::Left)
			.unwrap_err();
		assert!(matches!(err, InputError::Coord(_)));
		// Button was pressed then released on the error path; none left held.
		assert!(!c.has_held_buttons());
		let releases = c
			.ops_ref()
			.iter()
			.filter(|op| matches!(op, SinkOp::Button { down: false, .. }))
			.count();
		assert_eq!(releases, 1);
	}

	#[test]
	fn release_all_releases_a_stuck_button() {
		let mut c = InputController::new(RecordingSink::default());
		// Press without releasing by starting a drag whose destination is invalid
		// is covered above; here force a held state via a press through click then
		// simulate a held button using a manual press path.
		c.move_to(&display(), 10.0, 10.0).unwrap();
		c.press_for_test(MouseButton::Left);
		assert!(c.has_held_buttons());
		c.release_all();
		assert!(!c.has_held_buttons());
		assert!(matches!(c.ops_ref().last(), Some(SinkOp::Button { down: false, .. })));
		// release_all is idempotent.
		c.release_all();
		assert!(!c.has_held_buttons());
	}

	#[test]
	fn move_out_of_bounds_errors_without_emitting_move() {
		let mut c = InputController::new(RecordingSink::default());
		let err = c.move_to(&display(), 200.0, 0.0).unwrap_err();
		assert!(matches!(err, InputError::Coord(_)));
		assert!(c.ops_ref().is_empty());
	}

	#[test]
	fn keypress_maps_names_and_rejects_unknown() {
		let mut c = InputController::new(RecordingSink::default());
		c.keypress(&["enter".to_string(), "tab".to_string()])
			.unwrap();
		assert_eq!(c.ops_ref(), &[
			SinkOp::Key { code: 36, down: true },
			SinkOp::Key { code: 36, down: false },
			SinkOp::Key { code: 48, down: true },
			SinkOp::Key { code: 48, down: false },
		]);
		let err = c
			.keypress(&["definitely-not-a-key".to_string()])
			.unwrap_err();
		assert!(matches!(err, InputError::UnknownKey(_)));
	}

	#[test]
	fn type_text_forwards_unicode() {
		let mut c = InputController::new(RecordingSink::default());
		c.type_text("héllo");
		assert_eq!(c.into_ops(), vec![SinkOp::TypeUnicode("héllo".to_string())]);
	}

	#[test]
	fn key_code_table_covers_common_names() {
		assert_eq!(key_code_for("Return"), Some(36));
		assert_eq!(key_code_for("ESC"), Some(53));
		assert_eq!(key_code_for("up"), Some(126));
		assert_eq!(key_code_for("nope"), None);
	}

	// Test-only helpers on the controller.
	impl InputController<RecordingSink> {
		fn into_ops(self) -> Vec<SinkOp> {
			self.sink.ops
		}

		fn ops_ref(&self) -> &[SinkOp] {
			&self.sink.ops
		}

		fn press_for_test(&mut self, button: MouseButton) {
			let at = self.cursor();
			self.press(at, button);
		}
	}
}

#[cfg(all(test, target_os = "macos"))]
mod live_tests {
	use super::{MouseButton, current_cursor_position, guarded_controller};
	use crate::computer::capture::capture_primary_display;

	/// Fires a real cursor move (no clicks/keys) and reads the position back to
	/// prove the CGEvent input pipeline works end to end. Ignored by default;
	/// run with `--ignored` on a macOS host with Accessibility granted.
	#[test]
	#[ignore = "moves the real cursor; needs macOS + Accessibility granted"]
	fn cursor_move_lands_near_target() {
		let frame = capture_primary_display().expect("capture (Screen Recording) should be granted");
		let display = frame.display;
		let Ok(mut controller) = guarded_controller() else {
			panic!("Accessibility must be granted for input injection");
		};

		// Target the display center — a safe interior point, well away from edges.
		let target_px = f64::from(display.width_px) / 2.0;
		let target_py = f64::from(display.height_px) / 2.0;
		controller
			.move_to(&display, target_px, target_py)
			.expect("move_to should succeed");

		let expected = display
			.to_logical_point(target_px, target_py)
			.expect("center is in bounds");
		let pos = current_cursor_position();
		let dx = (pos.x - expected.x).abs();
		let dy = (pos.y - expected.y).abs();
		assert!(
			dx <= 2.0 && dy <= 2.0,
			"cursor landed at ({}, {}), expected ~({}, {})",
			pos.x,
			pos.y,
			expected.x,
			expected.y
		);
		assert_eq!(controller.cursor(), expected);
		// We only moved the cursor; nothing should be held.
		assert!(!controller.has_held_buttons());
		let _ = MouseButton::Left; // keep the import meaningful for future click tests
	}

	/// Durable output directory for G005 live-acceptance artifacts. Override
	/// with `COMPUTER_USE_ACCEPTANCE_DIR`; defaults to
	/// `<repo-root>/.gjc/ultragoal/artifacts/g005`.
	fn acceptance_artifacts_dir() -> std::path::PathBuf {
		if let Ok(dir) = std::env::var("COMPUTER_USE_ACCEPTANCE_DIR") {
			return std::path::PathBuf::from(dir);
		}
		std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.gjc/ultragoal/artifacts/g005")
	}

	/// G005 acceptance drill: drives all nine primitives through the gated
	/// execute_input path against the focused frontmost app, then waits for a
	/// human kill-switch press and proves input is blocked afterward.
	#[test]
	#[ignore = "live G005: drives the focused app + needs a human hotkey press"]
	fn all_nine_acceptance_drill() {
		use std::{thread::sleep, time::Duration};

		use crate::computer::{
			capture::capture_primary_display,
			executor::{InputAction, MacDisplayContext, MacPermissionGate, execute_input},
			hotkey,
			supervisor::Supervisor,
		};

		assert!(hotkey::start(), "kill-switch hotkey listener must be live");
		let frame = capture_primary_display().expect("Screen Recording granted"); // primitive 1: screenshot
		let display = frame.display;
		let perms = MacPermissionGate;
		let dctx = MacDisplayContext;
		let cancel = || false;
		let cx = f64::from(display.width_px) * 0.5;
		let cy = f64::from(display.height_px) * 0.42;

		// Persist the pre-input frame as durable live-proof (primitive 1).
		let artifacts = acceptance_artifacts_dir();
		std::fs::create_dir_all(&artifacts).expect("create acceptance artifacts dir");
		std::fs::write(artifacts.join("g005-before.png"), &frame.png)
			.expect("write before screenshot");

		let act = |action: InputAction| {
			// Stand in for the listener's periodic heartbeat so input_allowed stays fresh.
			Supervisor::global().heartbeat();
			let mut controller = guarded_controller().expect("Accessibility granted");
			execute_input(
				&action,
				Supervisor::global(),
				&perms,
				&dctx,
				None,
				&display,
				&mut controller,
				&cancel,
			)
			.expect("gated action should succeed");
			sleep(Duration::from_millis(350));
		};

		act(InputAction::Move { x: cx, y: cy }); // 2 move
		act(InputAction::Click { x: cx, y: cy, button: MouseButton::Left }); // 3 click (focus body)
		act(InputAction::Type { text: "COMPUTER_USE_E2E gajae ".to_string() }); // 4 type
		act(InputAction::Keypress { keys: vec!["return".to_string()] }); // 5 keypress
		act(InputAction::Type { text: "line two alpha beta gamma delta epsilon".to_string() });
		act(InputAction::DoubleClick { x: cx, y: cy, button: MouseButton::Left }); // 6 double_click
		act(InputAction::Drag {
			x:      cx - 120.0,
			y:      cy,
			to_x:   cx + 120.0,
			to_y:   cy,
			button: MouseButton::Left,
		}); // 7 drag
		act(InputAction::Scroll { x: cx, y: cy, scroll_x: 0.0, scroll_y: -120.0 }); // 8 scroll
		act(InputAction::Wait { ms: 300 }); // 9 wait

		println!(">>> KILL-SWITCH DRILL: press Control+Option+Command+Escape now (within ~60s) <<<");
		for _ in 0..300 {
			if Supervisor::global().is_suspended() {
				break;
			}
			sleep(Duration::from_millis(200));
		}
		assert!(
			Supervisor::global().is_suspended(),
			"kill-switch should latch after you press the hotkey"
		);

		// Prove input is blocked after the kill-switch, until a user-only reset.
		let mut controller = guarded_controller().expect("Accessibility granted");
		let blocked = execute_input(
			&InputAction::Move { x: cx, y: cy },
			Supervisor::global(),
			&perms,
			&dctx,
			None,
			&display,
			&mut controller,
			&cancel,
		);
		assert!(blocked.is_err(), "input must be blocked while suspended");

		// Capture + persist the post-kill-switch frame and a transcript so the
		// G004 mandatory computer red-team suite has durable native proof on disk.
		let after = capture_primary_display().expect("Screen Recording granted");
		std::fs::write(artifacts.join("g005-after-killswitch.png"), &after.png)
			.expect("write post-kill-switch screenshot");
		let manifest = serde_json::json!({
			"schemaVersion": 1,
			"kind": "computer-use-acceptance",
			"surface": "native",
			"hotkey": "Control+Option+Command+Escape",
			"display": {
				"widthPx": display.width_px,
				"heightPx": display.height_px,
				"epoch": frame.display_epoch
			},
			"primitives": [
				"screenshot",
				"move",
				"click",
				"type",
				"keypress",
				"double_click",
				"drag",
				"scroll",
				"wait"
			],
			"killSwitch": { "latched": true, "blockedFurtherInput": true },
			"artifacts": {
				"before": "g005-before.png",
				"afterKillSwitch": "g005-after-killswitch.png"
			}
		});
		std::fs::write(
			artifacts.join("g005-manifest.json"),
			serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
		)
		.expect("write acceptance manifest");
		println!("G005 artifacts written to {}", artifacts.display());
		Supervisor::global().reset();
		println!(
			"G005 PASS: all nine primitives executed; kill-switch latched and blocked further input."
		);
	}
}
