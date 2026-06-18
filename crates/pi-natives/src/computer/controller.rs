//! N-API controller surface for macOS computer-use.
//!
//! Side-effecting methods are thin adapters: they construct an [`InputAction`]
//! and delegate to [`execute_input`]. No direct input controller methods are
//! called from this module.

use napi::bindgen_prelude::Uint8Array;
use napi_derive::napi;

use crate::computer::{
	ComputerScreenshot,
	capture::capture_primary_display,
	executor::{ExecError, InputAction, MacDisplayContext, MacPermissionGate, execute_input},
	hotkey,
	input::{MouseButton, guarded_controller},
	supervisor::Supervisor,
};

#[napi]
pub struct ComputerController;

#[napi]
impl ComputerController {
	#[napi(constructor)]
	pub const fn new() -> Self {
		Self
	}

	#[napi]
	pub fn screenshot(&self) -> napi::Result<ComputerScreenshot> {
		let frame =
			capture_primary_display().map_err(|err| napi::Error::from_reason(format!("{err}")))?;
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

	#[napi]
	pub fn click(
		&self,
		expected_epoch: Option<f64>,
		x: f64,
		y: f64,
		button: Option<String>,
	) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Click { x, y, button: parse_button(button)? })
	}

	#[napi(js_name = "doubleClick")]
	pub fn double_click(
		&self,
		expected_epoch: Option<f64>,
		x: f64,
		y: f64,
		button: Option<String>,
	) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::DoubleClick {
			x,
			y,
			button: parse_button(button)?,
		})
	}

	#[napi]
	pub fn move_(&self, expected_epoch: Option<f64>, x: f64, y: f64) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Move { x, y })
	}

	#[napi]
	pub fn drag(
		&self,
		expected_epoch: Option<f64>,
		x: f64,
		y: f64,
		to_x: f64,
		to_y: f64,
		button: Option<String>,
	) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Drag {
			x,
			y,
			to_x,
			to_y,
			button: parse_button(button)?,
		})
	}

	#[napi]
	pub fn scroll(
		&self,
		expected_epoch: Option<f64>,
		x: f64,
		y: f64,
		scroll_x: f64,
		scroll_y: f64,
	) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Scroll { x, y, scroll_x, scroll_y })
	}

	#[napi(js_name = "type")]
	pub fn type_(&self, expected_epoch: Option<f64>, text: String) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Type { text })
	}

	#[napi]
	pub fn keypress(&self, expected_epoch: Option<f64>, keys: Vec<String>) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Keypress { keys })
	}

	#[napi]
	pub fn wait(&self, expected_epoch: Option<f64>, ms: u32) -> napi::Result<()> {
		Self::execute(expected_epoch, InputAction::Wait { ms: u64::from(ms) })
	}

	fn execute(expected_epoch: Option<f64>, action: InputAction) -> napi::Result<()> {
		hotkey::start();
		let frame =
			capture_primary_display().map_err(|err| napi::Error::from_reason(format!("{err}")))?;
		let display = frame.display;
		let mut controller = guarded_controller()
			.map_err(|err| napi_error("COMPUTER_PERMISSION_REQUIRED", err.to_string()))?;
		let cancel = || Supervisor::global().is_suspended();
		execute_input(
			&action,
			Supervisor::global(),
			&MacPermissionGate,
			&MacDisplayContext,
			expected_epoch.map(epoch_from_f64),
			&display,
			&mut controller,
			&cancel,
		)
		.map_err(exec_error)
	}
}

impl Default for ComputerController {
	fn default() -> Self {
		Self::new()
	}
}
fn parse_button(button: Option<String>) -> napi::Result<MouseButton> {
	match button
		.as_deref()
		.unwrap_or("left")
		.to_ascii_lowercase()
		.as_str()
	{
		"left" => Ok(MouseButton::Left),
		"right" => Ok(MouseButton::Right),
		"center" | "middle" => Ok(MouseButton::Center),
		other => Err(napi_error("COMPUTER_COORD_INVALID", format!("unknown mouse button: {other}"))),
	}
}

fn epoch_from_f64(value: f64) -> u64 {
	if value.is_finite() && value >= 0.0 {
		value as u64
	} else {
		u64::MAX
	}
}

fn exec_error(err: ExecError) -> napi::Error {
	napi_error(err.code(), err.to_string())
}

fn napi_error(code: &'static str, reason: String) -> napi::Error {
	napi::Error::new(napi::Status::GenericFailure, format!("{code}: {reason}"))
}
