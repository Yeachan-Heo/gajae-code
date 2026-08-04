//! N-API controller surface for macOS computer-use.

use std::{
	collections::HashMap,
	time::{Duration, Instant},
};

use napi::bindgen_prelude::{Uint8Array, Unknown};
use napi_derive::napi;

use crate::{
	computer::{
		ComputerScreenshot,
		capture::capture_primary_display,
		executor::{
			ExecError, InputAction, MacDisplayContext, MacPermissionGate, execute_input,
			execute_input_transaction, execute_wait, with_cursor_transaction,
		},
		hotkey,
		input::{MacCursorHooks, MouseButton, guarded_controller},
		supervisor::Supervisor,
	},
	task::{CancelToken, Promise, blocking},
};

/// One native batch step. Field names deliberately mirror the current JS action
/// DTO.
#[napi(object)]
pub struct ComputerInputAction {
	pub action:        String,
	pub x:             Option<f64>,
	pub y:             Option<f64>,
	pub to_x:          Option<f64>,
	pub to_y:          Option<f64>,
	pub scroll_x:      Option<f64>,
	pub scroll_y:      Option<f64>,
	pub button:        Option<String>,
	pub text:          Option<String>,
	pub keys:          Option<Vec<String>>,
	pub ms:            Option<u32>,
	pub timeout_ms:    Option<u32>,
	pub timeout_group: Option<u32>,
}

#[napi(object)]
pub struct ComputerBatchStepResult {
	pub index:      u32,
	pub action:     String,
	pub screenshot: Option<ComputerScreenshot>,
}

#[napi(object)]
pub struct ComputerBatchResult {
	pub results:                 Vec<ComputerBatchStepResult>,
	pub failure_code:            Option<String>,
	pub failure_index:           Option<u32>,
	pub failure_message:         Option<String>,
	pub primary_failure_code:    Option<String>,
	pub primary_failure_message: Option<String>,
}

enum BatchAction {
	Input {
		name:          String,
		action:        InputAction,
		timeout_ms:    Option<u32>,
		timeout_group: Option<u32>,
	},
	Screenshot {
		timeout_ms:    Option<u32>,
		timeout_group: Option<u32>,
	},
}

impl BatchAction {
	fn timeout_ms(&self) -> Option<u32> {
		match self {
			Self::Input { timeout_ms, .. } | Self::Screenshot { timeout_ms, .. } => *timeout_ms,
		}
	}

	fn timeout_group(&self) -> Option<u32> {
		match self {
			Self::Input { timeout_group, .. } | Self::Screenshot { timeout_group, .. } => {
				*timeout_group
			},
		}
	}
}

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
		capture_primary_display()
			.map(screenshot_from_frame)
			.map_err(capture_error)
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
		// A pure wait has no cursor side effects and deliberately skips capture.
		let actions = [InputAction::Wait { ms: u64::from(ms) }];
		Self::execute_actions(expected_epoch, &actions)
	}

	#[napi(js_name = "executeBatch")]
	pub fn execute_batch(
		&self,
		expected_epoch: Option<f64>,
		actions: Vec<ComputerInputAction>,
		timeout_ms: Option<u32>,
		signal: Option<Unknown>,
	) -> napi::Result<Promise<ComputerBatchResult>> {
		// Parse the entire list before capture, permission checks, or input.
		let actions = actions
			.into_iter()
			.enumerate()
			.map(|(index, action)| {
				parse_batch_action(action).map_err(|reason| {
					napi_error("COMPUTER_COORD_INVALID", format!("action {index}: {reason}"))
				})
			})
			.collect::<napi::Result<Vec<_>>>()?;
		let cancel_token = CancelToken::new(timeout_ms, signal);
		Ok(blocking("computer_execute_batch", cancel_token, move |cancel_token| {
			Self::execute_batch_actions(expected_epoch, &actions, &|| cancel_token.aborted())
		}))
	}

	fn execute(expected_epoch: Option<f64>, action: InputAction) -> napi::Result<()> {
		Self::execute_actions(expected_epoch, &[action])
	}

	fn execute_actions(expected_epoch: Option<f64>, actions: &[InputAction]) -> napi::Result<()> {
		if actions
			.iter()
			.all(|action| matches!(action, InputAction::Wait { .. }))
		{
			for action in actions {
				Self::run_wait(action, &|| false).map_err(exec_error)?;
			}
			return Ok(());
		}

		hotkey::start();
		let frame = capture_primary_display().map_err(capture_error)?;
		let display = frame.display;
		let mut controller = guarded_controller()
			.map_err(|err| napi_error("COMPUTER_PERMISSION_REQUIRED", err.to_string()))?;
		let cancel = || Supervisor::global().is_suspended();
		let mut hooks = MacCursorHooks;
		execute_input_transaction(
			actions,
			Supervisor::global(),
			&MacPermissionGate,
			&MacDisplayContext,
			expected_epoch.map(epoch_from_f64),
			&display,
			&mut controller,
			&mut hooks,
			&cancel,
		)
		.map_err(exec_error)
	}

	fn execute_batch_actions(
		expected_epoch: Option<f64>,
		actions: &[BatchAction],
		cancelled: &dyn Fn() -> bool,
	) -> napi::Result<ComputerBatchResult> {
		let needs_input = actions.iter().any(|action| {
			matches!(action, BatchAction::Input {
				action: InputAction::Click { .. }
					| InputAction::DoubleClick { .. }
					| InputAction::Move { .. }
					| InputAction::Drag { .. }
					| InputAction::Scroll { .. }
					| InputAction::Type { .. }
					| InputAction::Keypress { .. },
				..
			})
		});
		let supervisor = Supervisor::global();
		let batch_cancelled = || supervisor.is_suspended() || cancelled();
		let mut results = Vec::new();
		let mut grouped_deadlines = HashMap::new();

		if actions.iter().all(|action| {
			matches!(action, BatchAction::Input { action: InputAction::Wait { .. }, .. })
		}) {
			for (index, action) in actions.iter().enumerate() {
				let deadline = batch_action_deadline(action, &mut grouped_deadlines);
				let step_cancelled =
					|| batch_cancelled() || deadline.is_some_and(|value| Instant::now() >= value);
				if step_cancelled() {
					return Ok(batch_failure(
						results,
						ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) },
						None,
					));
				}
				let BatchAction::Input { name, action, .. } = action else {
					unreachable!("all-wait batches only contain wait steps")
				};
				if let Err(source) = Self::run_wait(action, &step_cancelled) {
					return Ok(batch_failure(
						results,
						ExecError::ActionFailed { index, source: Box::new(source) },
						None,
					));
				}
				if step_cancelled() {
					return Ok(batch_failure(
						results,
						ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) },
						None,
					));
				}
				results.push(ComputerBatchStepResult {
					index:      index as u32,
					action:     name.clone(),
					screenshot: None,
				});
			}
			return Ok(batch_success(results));
		}

		if !needs_input {
			for (index, action) in actions.iter().enumerate() {
				let deadline = batch_action_deadline(action, &mut grouped_deadlines);
				let step_cancelled =
					|| batch_cancelled() || deadline.is_some_and(|value| Instant::now() >= value);
				if step_cancelled() {
					return Ok(batch_failure(
						results,
						ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) },
						None,
					));
				}
				match action {
					BatchAction::Screenshot { .. } => match capture_primary_display() {
						Ok(frame) => {
							if step_cancelled() {
								return Ok(batch_failure(
									results,
									ExecError::ActionFailed {
										index,
										source: Box::new(ExecError::Cancelled),
									},
									None,
								));
							}
							results.push(ComputerBatchStepResult {
								index:      index as u32,
								action:     "screenshot".to_string(),
								screenshot: Some(screenshot_from_frame(frame)),
							});
						},
						Err(err) => {
							return Ok(batch_failure(
								results,
								ExecError::ActionFailed {
									index,
									source: Box::new(ExecError::ScreenshotFailed),
								},
								Some(format!("COMPUTER_SCREENSHOT_FAILED: {err}")),
							));
						},
					},
					BatchAction::Input { name, action, .. } => {
						if let Err(source) = Self::run_wait(action, &step_cancelled) {
							return Ok(batch_failure(
								results,
								ExecError::ActionFailed { index, source: Box::new(source) },
								None,
							));
						}
						if step_cancelled() {
							return Ok(batch_failure(
								results,
								ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) },
								None,
							));
						}
						results.push(ComputerBatchStepResult {
							index:      index as u32,
							action:     name.clone(),
							screenshot: None,
						});
					},
				}
			}
			return Ok(batch_success(results));
		}

		hotkey::start();
		if batch_cancelled() {
			return Ok(batch_failure(results, ExecError::Cancelled, None));
		}
		let initial = match capture_primary_display() {
			Ok(frame) => frame,
			Err(err) => {
				return Ok(batch_failure(
					results,
					ExecError::ScreenshotFailed,
					Some(format!("COMPUTER_SCREENSHOT_FAILED: {err}")),
				));
			},
		};
		if batch_cancelled() {
			return Ok(batch_failure(results, ExecError::Cancelled, None));
		}
		let mut display = initial.display;
		let mut expected_epoch = expected_epoch.map(epoch_from_f64);
		let first_input_index = actions
			.iter()
			.position(|action| matches!(action, BatchAction::Input { action, .. } if !matches!(action, InputAction::Wait { .. })))
			.unwrap_or(0);
		let mut controller = match guarded_controller() {
			Ok(controller) => controller,
			Err(_) => {
				return Ok(batch_failure(
					results,
					ExecError::ActionFailed {
						index:  first_input_index,
						source: Box::new(ExecError::PermissionRequired),
					},
					None,
				));
			},
		};
		let mut hooks = MacCursorHooks;
		let transaction =
			with_cursor_transaction(&mut controller, &mut hooks, &batch_cancelled, |controller| {
				for (index, action) in actions.iter().enumerate() {
					let deadline = batch_action_deadline(action, &mut grouped_deadlines);
					let step_cancelled =
						|| batch_cancelled() || deadline.is_some_and(|value| Instant::now() >= value);
					if step_cancelled() {
						return Err(ExecError::ActionFailed {
							index,
							source: Box::new(ExecError::Cancelled),
						});
					}
					match action {
						BatchAction::Screenshot { .. } => {
							let frame =
								capture_primary_display().map_err(|_| ExecError::ActionFailed {
									index,
									source: Box::new(ExecError::ScreenshotFailed),
								})?;
							if step_cancelled() {
								return Err(ExecError::ActionFailed {
									index,
									source: Box::new(ExecError::Cancelled),
								});
							}
							display = frame.display;
							expected_epoch = Some(frame.display_epoch);
							results.push(ComputerBatchStepResult {
								index:      index as u32,
								action:     "screenshot".to_string(),
								screenshot: Some(screenshot_from_frame(frame)),
							});
						},
						BatchAction::Input { name, action, .. } => {
							execute_input(
								action,
								supervisor,
								&MacPermissionGate,
								&MacDisplayContext,
								expected_epoch,
								&display,
								controller,
								&step_cancelled,
							)
							.map_err(|source| ExecError::ActionFailed {
								index,
								source: Box::new(source),
							})?;
							if step_cancelled() {
								return Err(ExecError::ActionFailed {
									index,
									source: Box::new(ExecError::Cancelled),
								});
							}
							results.push(ComputerBatchStepResult {
								index:      index as u32,
								action:     name.clone(),
								screenshot: None,
							});
						},
					}
				}
				Ok(())
			});
		Ok(match transaction {
			Ok(()) => batch_success(results),
			Err(err) => batch_failure(results, err, None),
		})
	}

	fn run_wait(action: &InputAction, cancelled: &dyn Fn() -> bool) -> Result<(), ExecError> {
		let InputAction::Wait { ms } = action else {
			unreachable!("input-free batches only contain wait steps")
		};
		hotkey::start();
		execute_wait(Supervisor::global(), *ms, cancelled)
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
fn parse_batch_action(dto: ComputerInputAction) -> Result<BatchAction, String> {
	let timeout_ms = dto.timeout_ms;
	let timeout_group = dto.timeout_group;
	if dto.action == "screenshot" {
		return Ok(BatchAction::Screenshot { timeout_ms, timeout_group });
	}
	parse_input_action(dto).map(|action| BatchAction::Input {
		name: action_name(&action).to_string(),
		action,
		timeout_ms,
		timeout_group,
	})
}

fn batch_action_deadline(
	action: &BatchAction,
	grouped_deadlines: &mut HashMap<u32, Instant>,
) -> Option<Instant> {
	batch_action_deadline_at(action, grouped_deadlines, Instant::now())
}

fn batch_action_deadline_at(
	action: &BatchAction,
	grouped_deadlines: &mut HashMap<u32, Instant>,
	now: Instant,
) -> Option<Instant> {
	let timeout = Duration::from_millis(u64::from(action.timeout_ms()?));
	let candidate = now + timeout;
	let Some(group) = action.timeout_group() else {
		return Some(candidate);
	};
	let deadline = grouped_deadlines
		.entry(group)
		.and_modify(|deadline| *deadline = (*deadline).min(candidate))
		.or_insert(candidate);
	Some(*deadline)
}
fn action_name(action: &InputAction) -> &'static str {
	match action {
		InputAction::Click { .. } => "click",
		InputAction::DoubleClick { .. } => "double_click",
		InputAction::Move { .. } => "move",
		InputAction::Drag { .. } => "drag",
		InputAction::Scroll { .. } => "scroll",
		InputAction::Type { .. } => "type",
		InputAction::Keypress { .. } => "keypress",
		InputAction::Wait { .. } => "wait",
	}
}
fn parse_input_action(dto: ComputerInputAction) -> Result<InputAction, String> {
	let finite = |name: &str, value: Option<f64>| {
		value
			.filter(|value| value.is_finite())
			.ok_or_else(|| format!("{name} must be a finite number"))
	};
	match dto.action.as_str() {
		"click" => Ok(InputAction::Click {
			x:      finite("x", dto.x)?,
			y:      finite("y", dto.y)?,
			button: parse_button(dto.button).map_err(|err| err.to_string())?,
		}),
		"double_click" => Ok(InputAction::DoubleClick {
			x:      finite("x", dto.x)?,
			y:      finite("y", dto.y)?,
			button: parse_button(dto.button).map_err(|err| err.to_string())?,
		}),
		"move" => Ok(InputAction::Move { x: finite("x", dto.x)?, y: finite("y", dto.y)? }),
		"drag" => Ok(InputAction::Drag {
			x:      finite("x", dto.x)?,
			y:      finite("y", dto.y)?,
			to_x:   finite("toX", dto.to_x)?,
			to_y:   finite("toY", dto.to_y)?,
			button: parse_button(dto.button).map_err(|err| err.to_string())?,
		}),
		"scroll" => Ok(InputAction::Scroll {
			x:        finite("x", dto.x)?,
			y:        finite("y", dto.y)?,
			scroll_x: finite("scrollX", dto.scroll_x)?,
			scroll_y: finite("scrollY", dto.scroll_y)?,
		}),
		"type" => {
			Ok(InputAction::Type { text: dto.text.ok_or_else(|| "text is required".to_string())? })
		},
		"keypress" => {
			Ok(InputAction::Keypress { keys: dto.keys.ok_or_else(|| "keys is required".to_string())? })
		},
		"wait" => Ok(InputAction::Wait {
			ms: u64::from(dto.ms.ok_or_else(|| "ms is required".to_string())?),
		}),
		other => Err(format!("unknown batch action: {other}")),
	}
}
fn screenshot_from_frame(frame: crate::computer::capture::CapturedFrame) -> ComputerScreenshot {
	ComputerScreenshot {
		png:           Uint8Array::from(frame.png),
		width_px:      frame.display.width_px,
		height_px:     frame.display.height_px,
		scale_x:       frame.display.scale_x,
		scale_y:       frame.display.scale_y,
		origin_x:      frame.display.origin_x,
		origin_y:      frame.display.origin_y,
		display_epoch: frame.display_epoch as f64,
		capture_id:    frame.capture_id,
	}
}
fn batch_success(results: Vec<ComputerBatchStepResult>) -> ComputerBatchResult {
	ComputerBatchResult {
		results,
		failure_code: None,
		failure_index: None,
		failure_message: None,
		primary_failure_code: None,
		primary_failure_message: None,
	}
}
fn batch_failure(
	results: Vec<ComputerBatchStepResult>,
	err: ExecError,
	override_message: Option<String>,
) -> ComputerBatchResult {
	let (primary_failure_code, primary_failure_message) = match &err {
		ExecError::CursorRestoreFailed { primary: Some(primary) } => {
			(Some(primary.code().to_string()), Some(primary.to_string()))
		},
		_ => (None, None),
	};
	ComputerBatchResult {
		results,
		failure_code: Some(err.code().to_string()),
		failure_index: action_failure_index(&err).map(|index| index as u32),
		failure_message: Some(override_message.unwrap_or_else(|| err.to_string())),
		primary_failure_code,
		primary_failure_message,
	}
}
fn action_failure_index(err: &ExecError) -> Option<usize> {
	match err {
		ExecError::ActionFailed { index, .. } => Some(*index),
		ExecError::CursorRestoreFailed { primary: Some(primary) } => action_failure_index(primary),
		_ => None,
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
fn capture_error(err: impl std::fmt::Display) -> napi::Error {
	napi_error("COMPUTER_SCREENSHOT_FAILED", err.to_string())
}
fn napi_error(code: &'static str, reason: String) -> napi::Error {
	napi::Error::new(napi::Status::GenericFailure, format!("{code}: {reason}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn screenshot(timeout_ms: u32, timeout_group: Option<u32>) -> BatchAction {
		BatchAction::Screenshot { timeout_ms: Some(timeout_ms), timeout_group }
	}

	fn input(timeout_ms: u32, timeout_group: Option<u32>) -> BatchAction {
		BatchAction::Input {
			name: "wait".to_string(),
			action: InputAction::Wait { ms: 0 },
			timeout_ms: Some(timeout_ms),
			timeout_group,
		}
	}

	#[test]
	fn input_and_synthetic_screenshot_share_one_deadline() {
		let now = Instant::now();
		let mut deadlines = HashMap::new();

		let input_deadline = batch_action_deadline_at(&input(5_000, Some(7)), &mut deadlines, now)
			.expect("input deadline");
		let screenshot_deadline = batch_action_deadline_at(
			&screenshot(5_000, Some(7)),
			&mut deadlines,
			now + Duration::from_secs(1),
		)
		.expect("screenshot deadline");

		assert_eq!(input_deadline, now + Duration::from_secs(5));
		assert_eq!(screenshot_deadline, input_deadline);
		assert_eq!(deadlines.get(&7), Some(&input_deadline));
	}

	#[test]
	fn shorter_grouped_timeout_can_only_shorten_deadline() {
		let now = Instant::now();
		let mut deadlines = HashMap::new();
		let first = batch_action_deadline_at(&screenshot(5_000, Some(7)), &mut deadlines, now)
			.expect("first deadline");
		let second = batch_action_deadline_at(
			&screenshot(1_000, Some(7)),
			&mut deadlines,
			now + Duration::from_secs(1),
		)
		.expect("shortened deadline");
		let third = batch_action_deadline_at(
			&screenshot(10_000, Some(7)),
			&mut deadlines,
			now + Duration::from_secs(2),
		)
		.expect("retained deadline");

		assert_eq!(first, now + Duration::from_secs(5));
		assert_eq!(second, now + Duration::from_secs(2));
		assert_eq!(third, second);
	}

	#[test]
	fn ungrouped_final_screenshot_has_an_independent_deadline() {
		let now = Instant::now();
		let mut deadlines = HashMap::new();
		let grouped = batch_action_deadline_at(&input(1_000, Some(0)), &mut deadlines, now)
			.expect("grouped deadline");
		let final_screenshot = batch_action_deadline_at(
			&screenshot(5_000, None),
			&mut deadlines,
			now + Duration::from_secs(1),
		)
		.expect("final screenshot deadline");

		assert_eq!(grouped, now + Duration::from_secs(1));
		assert_eq!(final_screenshot, now + Duration::from_secs(6));
		assert_eq!(deadlines.len(), 1);
	}
}
