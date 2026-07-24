//! Native computer-use primitives (macOS-only v1).
//!
//! # Overview
//! This module backs the model-facing `computer` tool: OS-native control of the
//! real macOS desktop via the `OpenAI` computer-use action set (`screenshot`,
//! `click`, `double_click`, `move`, `drag`, `scroll`, `type`, `keypress`,
//! `wait`).
//!
//! # Status
//! Slice 1 foundation. Only the framework-free coordinate contract
//! ([`coords`]) ships so far; it is unit-testable without a display or granted
//! TCC permissions. The native capture/input backend, the kill-switch
//! supervisor + event-tap lifecycle, and the napi `ComputerController` surface
//! land in later slices. See `docs/computer-use/` for the approved spec, the
//! consensus plan, and the architecture decision record.
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
