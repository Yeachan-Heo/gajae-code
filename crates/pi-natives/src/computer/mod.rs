//! Native computer-use primitives (macOS-only v1).
//!
//! # Overview
//! This module backs the model-facing `computer` tool: OS-native control of the
//! real macOS desktop via the `OpenAI` computer-use action set (`screenshot`,
//! `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
//! `wait`).
//!
//! # Status
//! Native capture, input, supervision, and the napi `ComputerController` exist.
//! The only input exposed for Gate-0 is a hidden, bounded harmless probe; the
//! production broker and public computer-use surface remain out of scope.
//!
//! # Architecture
//! ```text
//! model -> packages/coding-agent (computer tool, exact OpenAI schema)
//!       -> packages/natives (napi bindings)
//!       -> pi-natives::computer (execute_action state machine + backend)
//! ```

#[cfg(test)]
mod bypass_guard;
#[cfg(target_os = "macos")]
pub mod capture;
#[cfg(target_os = "macos")]
pub mod controller;
pub mod coords;
pub mod executor;
#[cfg(target_os = "macos")]
pub mod hotkey;
pub mod input;
#[cfg(target_os = "macos")]
pub mod permissions;
pub mod supervisor;

#[cfg(target_os = "macos")]
pub use capture::{CaptureError, CapturedFrame, capture_primary_display, current_display_epoch};
#[cfg(target_os = "macos")]
pub use controller::ComputerController;
pub use coords::{CoordError, LogicalPoint, NormalizedDisplay};
pub use input::{EventSink, InputController, InputError, MouseButton};
use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;
#[cfg(target_os = "macos")]
pub use permissions::{PermissionError, PreflightStatus, TccPermission, preflight};
pub use supervisor::{Supervisor, SupervisorStatus};

/// A captured primary-display screenshot returned to JS.
///
/// `width_px`/`height_px` are the physical pixels that define the action
/// coordinate space (see the coordinate contract); the scale/origin map them to
/// macOS logical points.
#[napi(object)]
pub struct ComputerScreenshot {
	/// PNG-encoded image bytes.
	pub png:           Uint8Array,
	/// Screenshot width in physical pixels.
	pub width_px:      u32,
	/// Screenshot height in physical pixels.
	pub height_px:     u32,
	/// Physical-pixels-per-logical-point along X.
	pub scale_x:       f64,
	/// Physical-pixels-per-logical-point along Y.
	pub scale_y:       f64,
	/// Logical origin X of the display (points).
	pub origin_x:      f64,
	/// Logical origin Y of the display (points).
	pub origin_y:      f64,
	/// Stable hash of the display geometry used for stale-display checks.
	pub display_epoch: f64,
	/// Process-local opaque capture id.
	pub capture_id:    u32,
}

/// Redacted Gate-0 TCC status. This contains grant state only.
#[napi(object)]
pub struct Gate0PermissionStatus {
	/// Whether Accessibility input injection is granted.
	pub accessibility:    bool,
	/// Whether Screen Recording capture is granted.
	pub screen_recording: bool,
}

/// Redacted Gate-0 harmless-probe outcome. No desktop data or coordinates are
/// returned.
#[napi(object)]
pub struct Gate0HarmlessProbeResult {
	/// Whether a screenshot could be captured and immediately discarded.
	pub screenshot:           bool,
	/// Whether Accessibility was granted when the probe ran.
	pub accessibility:        bool,
	/// Whether the cursor moved one logical pixel and was restored.
	pub pointer_move_restore: bool,
}

/// Capture the primary display for JS callers (macOS).
///
/// Requires the Screen Recording permission. This is the read-only `screenshot`
/// primitive of the computer-use tool; input primitives land behind the same
/// surface once the Accessibility gate is satisfied in a granted `gjc` process.
///
/// # Errors
/// Returns an error when capture fails (e.g. Screen Recording not granted).
#[napi(js_name = "computerScreenshot")]
pub fn computer_screenshot() -> napi::Result<ComputerScreenshot> {
	#[cfg(target_os = "macos")]
	{
		let frame = capture::capture_primary_display()
			.map_err(|err| napi::Error::from_reason(format!("{err}")))?;
		Ok(ComputerScreenshot {
			png:           Uint8Array::from(frame.png),
			width_px:      frame.display.width_px,
			height_px:     frame.display.height_px,
			scale_x:       frame.display.scale_x,
			scale_y:       frame.display.scale_y,
			origin_x:      frame.display.origin_x,
			origin_y:      frame.display.origin_y,
			display_epoch: frame.display_epoch as f64,
			capture_id:    frame.capture_id,
		})
	}
	#[cfg(not(target_os = "macos"))]
	{
		Err(napi::Error::from_reason("computer screenshot capture is only supported on macOS"))
	}
}
