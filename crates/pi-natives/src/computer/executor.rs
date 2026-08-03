//! Central supervisor-gated execution for computer-use input.
//!
//! # Single side-effect authority
//! Every side-effecting input action passes [`execute_input`] before the
//! [`InputController`] touches the OS. The gate is fail-closed: it requires the
//! supervisor stop-path live + fresh + not-suspended, Accessibility granted,
//! and (for coordinate actions) a matching display epoch. `release_all` runs on
//! every non-success exit and whenever suspension is observed mid-flight, so a
//! partial drag never leaves a button held. Screenshot is read-only (see
//! [`super::capture`]) and is intentionally NOT gated here.
//!
//! The gate logic is OS-agnostic and unit-tested with a fake permission gate,
//! fake display context, a real [`Supervisor`], and a recording [`EventSink`];
//! macOS supplies the concrete permission/display providers.

use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{LazyLock, Mutex, TryLockError},
	time::Duration,
};

use super::{
	coords::{CoordError, NormalizedDisplay},
	input::{CursorHooks, EventSink, InputController, InputError, MouseButton},
	supervisor::Supervisor,
};

static INPUT_TRANSACTION: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

/// A side-effecting computer-use action (the 8 input primitives). Screenshot is
/// handled by the read-only capture path, not this executor.
#[derive(Debug, Clone, PartialEq)]
pub enum InputAction {
	/// Move + click.
	Click { x: f64, y: f64, button: MouseButton },
	/// Move + double click.
	DoubleClick { x: f64, y: f64, button: MouseButton },
	/// Move the cursor.
	Move { x: f64, y: f64 },
	/// Press, drag, release.
	Drag { x: f64, y: f64, to_x: f64, to_y: f64, button: MouseButton },
	/// Move + scroll by logical deltas.
	Scroll { x: f64, y: f64, scroll_x: f64, scroll_y: f64 },
	/// Type a unicode string.
	Type { text: String },
	/// Press/release named keys in order.
	Keypress { keys: Vec<String> },
	/// Abort-aware wait.
	Wait { ms: u64 },
}

impl InputAction {
	/// Whether the action targets a screenshot-space coordinate (and so needs a
	/// fresh, matching display epoch).
	#[must_use]
	pub const fn is_coordinate(&self) -> bool {
		matches!(
			self,
			Self::Click { .. }
				| Self::DoubleClick { .. }
				| Self::Move { .. }
				| Self::Drag { .. }
				| Self::Scroll { .. }
		)
	}
}

/// Reason an action was rejected or failed. Each maps to a stable error code so
/// the TS tool can surface consistent, actionable messages.
#[derive(Debug, Clone, PartialEq)]
pub enum ExecError {
	/// Kill-switch latched; input stays off until a user-only reset.
	Suspended,
	/// The global stop path is not live/fresh; input is disabled fail-closed.
	SupervisorNotLive,
	/// Accessibility is not granted; no input may be injected.
	PermissionRequired,
	/// The display changed since the screenshot the coordinates came from.
	DisplayStale,
	/// A coordinate was out of bounds / non-finite / invalid scale.
	Coord(CoordError),
	/// Core Graphics failed to move the hardware cursor.
	CursorWarpFailed(i32),
	/// The action was cancelled (AbortSignal/timeout/supervisor stop).
	Cancelled,
	/// A key name was not recognized.
	UnknownKey(String),
	/// A screenshot step could not capture the display.
	ScreenshotFailed,
	/// A batch action failed at this zero-based index.
	ActionFailed { index: usize, source: Box<Self> },
	/// The cursor could not be captured before an input transaction began.
	CursorCaptureFailed,
	/// Cursor restoration failed, optionally after an action failure.
	CursorRestoreFailed { primary: Option<Box<Self>> },
	/// The process-global input transaction mutex was poisoned.
	TransactionPoisoned,
	/// An unexpected panic occurred after cursor capture.
	TransactionPanicked,
}

impl ExecError {
	/// Stable error code string for the TS surface.
	#[must_use]
	pub const fn code(&self) -> &'static str {
		match self {
			Self::Suspended => "COMPUTER_SUSPENDED",
			Self::SupervisorNotLive => "COMPUTER_SUPERVISOR_NOT_LIVE",
			Self::PermissionRequired => "COMPUTER_PERMISSION_REQUIRED",
			Self::DisplayStale => "COMPUTER_DISPLAY_STALE",
			Self::Coord(_) => "COMPUTER_COORD_INVALID",
			Self::CursorWarpFailed(_) => "COMPUTER_CURSOR_WARP_FAILED",
			Self::UnknownKey(_) => "COMPUTER_UNKNOWN_KEY",
			Self::Cancelled => "COMPUTER_CANCELLED",
			Self::ScreenshotFailed => "COMPUTER_SCREENSHOT_FAILED",
			Self::ActionFailed { source, .. } => source.code(),
			Self::CursorCaptureFailed => "COMPUTER_CURSOR_CAPTURE_FAILED",
			Self::CursorRestoreFailed { .. } => "COMPUTER_CURSOR_RESTORE_FAILED",
			Self::TransactionPoisoned | Self::TransactionPanicked => "COMPUTER_TRANSACTION_FAILED",
		}
	}
}

impl From<InputError> for ExecError {
	fn from(value: InputError) -> Self {
		match value {
			InputError::Coord(err) => Self::Coord(err),
			InputError::CursorWarpFailed(status) => Self::CursorWarpFailed(status),
			InputError::UnknownKey(key) => Self::UnknownKey(key),
		}
	}
}

impl std::fmt::Display for ExecError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			Self::Coord(err) => write!(f, "{}: {err}", self.code()),
			Self::CursorWarpFailed(status) => {
				write!(f, "{}: cursor warp failed with status {status}", self.code())
			},
			Self::UnknownKey(key) => write!(f, "{}: {key}", self.code()),
			Self::ActionFailed { index, source } => write!(f, "action {index}: {source}"),
			Self::CursorRestoreFailed { primary: Some(primary) } => {
				write!(f, "{} after {primary}", self.code())
			},
			Self::TransactionPoisoned => {
				write!(f, "{}: input transaction mutex is poisoned", self.code())
			},
			Self::TransactionPanicked => write!(f, "{}: input transaction panicked", self.code()),
			_ => write!(f, "{}", self.code()),
		}
	}
}

impl std::error::Error for ExecError {}

/// Provides the current Accessibility (input) grant state. macOS implements
/// this over `permissions::accessibility_granted`; tests inject a fake.
pub trait PermissionGate {
	/// Whether Accessibility is currently granted.
	fn accessibility_granted(&self) -> bool;
}

/// Provides the current display epoch so coordinate actions can reject stale
/// screenshots. macOS implements this over the capture/display descriptor.
pub trait DisplayContext {
	/// The current display epoch (hash of topology/scale/origin).
	fn current_epoch(&self) -> u64;
}

#[cfg(target_os = "macos")]
pub struct MacPermissionGate;

#[cfg(target_os = "macos")]
impl PermissionGate for MacPermissionGate {
	fn accessibility_granted(&self) -> bool {
		crate::computer::permissions::accessibility_granted()
	}
}

#[cfg(target_os = "macos")]
pub struct MacDisplayContext;

#[cfg(target_os = "macos")]
impl DisplayContext for MacDisplayContext {
	fn current_epoch(&self) -> u64 {
		crate::computer::capture::current_display_epoch()
	}
}

/// Fail-closed gate run before any side-effecting input.
fn gate<P: PermissionGate, D: DisplayContext>(
	action: &InputAction,
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
) -> Result<(), ExecError> {
	let status = supervisor.status();
	if status.suspended {
		return Err(ExecError::Suspended);
	}
	if !status.hotkey_live || !status.heartbeat_fresh {
		return Err(ExecError::SupervisorNotLive);
	}
	if !perms.accessibility_granted() {
		return Err(ExecError::PermissionRequired);
	}
	if action.is_coordinate()
		&& let Some(expected) = expected_epoch
		&& display_ctx.current_epoch() != expected
	{
		return Err(ExecError::DisplayStale);
	}
	Ok(())
}

/// Execute a supervisor-gated wait without requiring display capture,
/// Accessibility permission, or a cursor transaction.
pub fn execute_wait(
	supervisor: &Supervisor,
	ms: u64,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError> {
	let status = supervisor.status();
	if status.suspended {
		return Err(ExecError::Suspended);
	}
	if !status.hotkey_live || !status.heartbeat_fresh {
		return Err(ExecError::SupervisorNotLive);
	}
	if cancelled() {
		return Err(ExecError::Cancelled);
	}
	wait_abortable(ms, cancelled)?;
	if cancelled() {
		return Err(ExecError::Cancelled);
	}
	if supervisor.is_suspended() {
		return Err(ExecError::Suspended);
	}
	Ok(())
}
/// Execute a side-effecting input action through the fail-closed gate.
///
/// `cancelled` is polled before and (for multi-step actions) reflected via the
/// controller; on any error or observed suspension, `release_all` runs so no
/// mouse button or modifier is left held.
///
/// # Errors
/// Returns [`ExecError`] when the gate rejects (suspended / not-live /
/// permission / stale display), the action is cancelled, or the controller
/// reports a coordinate/key error.
/// Execute one input action, releasing any held state if it fails.
pub fn execute_input<S, P, D>(
	action: &InputAction,
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError>
where
	S: EventSink,
	P: PermissionGate,
	D: DisplayContext,
{
	let result = execute_one(
		action,
		supervisor,
		perms,
		display_ctx,
		expected_epoch,
		display,
		controller,
		cancelled,
	);
	let suspended = supervisor.is_suspended();
	if result.is_err() || suspended {
		controller.release_all();
	}
	if result.is_ok() && suspended {
		Err(ExecError::Suspended)
	} else {
		result
	}
}

/// Capture, execute, release, and restore one complete input transaction.
///
/// The process-global mutex spans capture through restore. Capture failure
/// posts no input; after a successful capture, held input is always released
/// before exactly one restore attempt.
pub fn with_cursor_transaction<S, H, T>(
	controller: &mut InputController<S>,
	hooks: &mut H,
	cancelled: &dyn Fn() -> bool,
	run: impl FnOnce(&mut InputController<S>) -> Result<T, ExecError>,
) -> Result<T, ExecError>
where
	S: EventSink,
	H: CursorHooks,
{
	let _transaction = loop {
		if cancelled() {
			return Err(ExecError::Cancelled);
		}
		match INPUT_TRANSACTION.try_lock() {
			Ok(lock) => break lock,
			Err(TryLockError::Poisoned(_)) => return Err(ExecError::TransactionPoisoned),
			Err(TryLockError::WouldBlock) => std::thread::sleep(Duration::from_millis(1)),
		}
	};
	if cancelled() {
		return Err(ExecError::Cancelled);
	}
	let cursor = hooks
		.capture_cursor()
		.map_err(|_| ExecError::CursorCaptureFailed)?;
	let mut primary = match catch_unwind(AssertUnwindSafe(|| run(controller))) {
		Ok(result) => result,
		Err(_) => Err(ExecError::TransactionPanicked),
	};
	if catch_unwind(AssertUnwindSafe(|| controller.release_all())).is_err() {
		primary = Err(ExecError::TransactionPanicked);
	}
	let restore = catch_unwind(AssertUnwindSafe(|| hooks.restore_cursor(cursor)));
	match restore {
		Ok(Ok(())) => primary,
		Ok(Err(_)) | Err(_) => {
			Err(ExecError::CursorRestoreFailed { primary: primary.err().map(Box::new) })
		},
	}
}

pub fn execute_input_transaction<S, H, P, D>(
	actions: &[InputAction],
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	hooks: &mut H,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError>
where
	S: EventSink,
	H: CursorHooks,
	P: PermissionGate,
	D: DisplayContext,
{
	with_cursor_transaction(controller, hooks, cancelled, |controller| {
		for (index, action) in actions.iter().enumerate() {
			if cancelled() {
				return Err(ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) });
			}
			execute_one(
				action,
				supervisor,
				perms,
				display_ctx,
				expected_epoch,
				display,
				controller,
				cancelled,
			)
			.map_err(|source| ExecError::ActionFailed { index, source: Box::new(source) })?;
			if cancelled() {
				return Err(ExecError::ActionFailed { index, source: Box::new(ExecError::Cancelled) });
			}
		}
		Ok(())
	})
}

fn execute_one<S, P, D>(
	action: &InputAction,
	supervisor: &Supervisor,
	perms: &P,
	display_ctx: &D,
	expected_epoch: Option<u64>,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError>
where
	S: EventSink,
	P: PermissionGate,
	D: DisplayContext,
{
	gate(action, supervisor, perms, display_ctx, expected_epoch)?;
	if cancelled() {
		return Err(ExecError::Cancelled);
	}
	let result = dispatch(action, display, controller, cancelled);
	if result.is_ok() && cancelled() {
		Err(ExecError::Cancelled)
	} else if result.is_ok() && supervisor.is_suspended() {
		Err(ExecError::Suspended)
	} else {
		result
	}
}

fn dispatch<S: EventSink>(
	action: &InputAction,
	display: &NormalizedDisplay,
	controller: &mut InputController<S>,
	cancelled: &dyn Fn() -> bool,
) -> Result<(), ExecError> {
	match action {
		InputAction::Click { x, y, button } => controller
			.click(display, *x, *y, *button)
			.map_err(Into::into),
		InputAction::DoubleClick { x, y, button } => controller
			.double_click(display, *x, *y, *button)
			.map_err(Into::into),
		InputAction::Move { x, y } => controller.move_to(display, *x, *y).map_err(Into::into),
		InputAction::Drag { x, y, to_x, to_y, button } => controller
			.drag(display, *x, *y, *to_x, *to_y, *button)
			.map_err(Into::into),
		InputAction::Scroll { x, y, scroll_x, scroll_y } => controller
			.scroll(display, *x, *y, *scroll_x, *scroll_y)
			.map_err(Into::into),
		InputAction::Type { text } => {
			controller.type_text(text);
			Ok(())
		},
		InputAction::Keypress { keys } => match controller.keypress(keys, cancelled) {
			Ok(true) => Ok(()),
			Ok(false) => Err(ExecError::Cancelled),
			Err(err) => Err(err.into()),
		},
		InputAction::Wait { ms } => wait_abortable(*ms, cancelled),
	}
}

/// Sleep up to `ms`, checking `cancelled` periodically.
fn wait_abortable(ms: u64, cancelled: &dyn Fn() -> bool) -> Result<(), ExecError> {
	use std::time::{Duration, Instant};
	let deadline = Instant::now() + Duration::from_millis(ms);
	while Instant::now() < deadline {
		if cancelled() {
			return Err(ExecError::Cancelled);
		}
		std::thread::sleep(Duration::from_millis(ms.min(10)));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{
		cell::{Cell, RefCell},
		rc::Rc,
	};

	use super::{
		DisplayContext, ExecError, InputAction, PermissionGate, execute_input,
		execute_input_transaction,
	};
	use crate::computer::{
		coords::{LogicalPoint, NormalizedDisplay},
		input::{CursorError, CursorHooks, EventSink, InputController, MouseButton, SinkOp},
		supervisor::Supervisor,
	};

	struct FakePerms {
		granted: bool,
	}
	impl PermissionGate for FakePerms {
		fn accessibility_granted(&self) -> bool {
			self.granted
		}
	}

	struct FakeDisplay {
		epoch: u64,
	}
	impl DisplayContext for FakeDisplay {
		fn current_epoch(&self) -> u64 {
			self.epoch
		}
	}

	#[derive(Default)]
	struct RecordingSink {
		ops: Vec<SinkOp>,
	}
	impl EventSink for RecordingSink {
		fn move_cursor(
			&mut self,
			to: LogicalPoint,
		) -> Result<(), crate::computer::input::InputError> {
			self.ops.push(SinkOp::Move(to));
			Ok(())
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
	struct WarpFailSink;

	impl EventSink for WarpFailSink {
		fn move_cursor(
			&mut self,
			_to: LogicalPoint,
		) -> Result<(), crate::computer::input::InputError> {
			Err(crate::computer::input::InputError::CursorWarpFailed(9))
		}

		fn mouse_button(&mut self, _at: LogicalPoint, _button: MouseButton, _down: bool) {}

		fn scroll(&mut self, _dx: f64, _dy: f64) {}

		fn type_unicode(&mut self, _text: &str) {}

		fn key(&mut self, _code: u16, _down: bool) {}
	}
	#[derive(Default)]
	struct RecordingHooks {
		captures:      usize,
		restores:      usize,
		capture_fails: bool,
		restore_fails: bool,
		capture_state: Option<Rc<Cell<bool>>>,
	}

	impl CursorHooks for RecordingHooks {
		fn capture_cursor(&mut self) -> Result<LogicalPoint, CursorError> {
			self.captures += 1;
			if let Some(state) = &self.capture_state {
				state.set(true);
			}
			if self.capture_fails {
				Err(CursorError::CaptureFailed)
			} else {
				Ok(LogicalPoint { x: 0.0, y: 0.0 })
			}
		}

		fn restore_cursor(&mut self, _to: LogicalPoint) -> Result<(), CursorError> {
			self.restores += 1;
			if self.restore_fails {
				Err(CursorError::RestoreFailed(1))
			} else {
				Ok(())
			}
		}
	}
	struct OrderedSink {
		log: Rc<RefCell<Vec<&'static str>>>,
	}

	impl EventSink for OrderedSink {
		fn move_cursor(
			&mut self,
			_to: LogicalPoint,
		) -> Result<(), crate::computer::input::InputError> {
			Ok(())
		}

		fn mouse_button(&mut self, _at: LogicalPoint, _button: MouseButton, down: bool) {
			self.log.borrow_mut().push(if down { "down" } else { "up" });
		}

		fn scroll(&mut self, _dx: f64, _dy: f64) {}

		fn type_unicode(&mut self, _text: &str) {}

		fn key(&mut self, _code: u16, _down: bool) {}
	}

	struct PanicReleaseSink {
		log: Rc<RefCell<Vec<&'static str>>>,
	}

	impl EventSink for PanicReleaseSink {
		fn move_cursor(
			&mut self,
			_to: LogicalPoint,
		) -> Result<(), crate::computer::input::InputError> {
			Ok(())
		}

		fn mouse_button(&mut self, _at: LogicalPoint, _button: MouseButton, down: bool) {
			self
				.log
				.borrow_mut()
				.push(if down { "down" } else { "release-panic" });
			if !down {
				panic!("injected release panic");
			}
		}

		fn scroll(&mut self, _dx: f64, _dy: f64) {}

		fn type_unicode(&mut self, _text: &str) {}

		fn key(&mut self, _code: u16, _down: bool) {}
	}

	struct PanicRestoreHooks {
		log: Rc<RefCell<Vec<&'static str>>>,
	}

	impl CursorHooks for PanicRestoreHooks {
		fn capture_cursor(&mut self) -> Result<LogicalPoint, CursorError> {
			self.log.borrow_mut().push("capture");
			Ok(LogicalPoint { x: 3.0, y: 4.0 })
		}

		fn restore_cursor(&mut self, _to: LogicalPoint) -> Result<(), CursorError> {
			self.log.borrow_mut().push("restore-panic");
			panic!("injected restore panic");
		}
	}

	struct OrderedHooks {
		log: Rc<RefCell<Vec<&'static str>>>,
	}

	impl CursorHooks for OrderedHooks {
		fn capture_cursor(&mut self) -> Result<LogicalPoint, CursorError> {
			self.log.borrow_mut().push("capture");
			Ok(LogicalPoint { x: 3.0, y: 4.0 })
		}

		fn restore_cursor(&mut self, to: LogicalPoint) -> Result<(), CursorError> {
			assert_eq!(to, LogicalPoint { x: 3.0, y: 4.0 });
			self.log.borrow_mut().push("restore");
			Ok(())
		}
	}

	fn display() -> NormalizedDisplay {
		NormalizedDisplay::new(200, 100, 2.0, 2.0, 0.0, 0.0)
	}

	fn live_supervisor() -> Supervisor {
		let s = Supervisor::new();
		s.set_hotkey_live(true);
		s.heartbeat();
		s
	}

	fn never_cancel() -> impl Fn() -> bool {
		|| false
	}

	fn run(
		action: &InputAction,
		sup: &Supervisor,
		granted: bool,
		expected_epoch: Option<u64>,
		current_epoch: u64,
	) -> (Result<(), ExecError>, Vec<SinkOp>) {
		let mut controller = InputController::new(RecordingSink::default());
		let perms = FakePerms { granted };
		let disp_ctx = FakeDisplay { epoch: current_epoch };
		let cancel = never_cancel();
		let res = execute_input(
			action,
			sup,
			&perms,
			&disp_ctx,
			expected_epoch,
			&display(),
			&mut controller,
			&cancel,
		);
		(res, controller.into_sink().ops)
	}

	#[test]
	fn suspended_rejects_before_any_sink_op() {
		let sup = live_supervisor();
		sup.trigger_stop();
		let (res, ops) = run(&InputAction::Move { x: 10.0, y: 10.0 }, &sup, true, None, 0);
		assert_eq!(res, Err(ExecError::Suspended));
		assert!(ops.is_empty(), "no events when suspended");
	}

	#[test]
	fn not_live_rejects() {
		let sup = Supervisor::new(); // hotkey not live
		let (res, ops) = run(
			&InputAction::Click { x: 1.0, y: 1.0, button: MouseButton::Left },
			&sup,
			true,
			None,
			0,
		);
		assert_eq!(res, Err(ExecError::SupervisorNotLive));
		assert!(ops.is_empty());
	}

	#[test]
	fn missing_accessibility_rejects() {
		let sup = live_supervisor();
		let (res, ops) = run(&InputAction::Move { x: 1.0, y: 1.0 }, &sup, false, None, 0);
		assert_eq!(res, Err(ExecError::PermissionRequired));
		assert!(ops.is_empty());
	}

	#[test]
	fn stale_display_epoch_rejects_coordinate_action() {
		let sup = live_supervisor();
		let (res, ops) = run(
			&InputAction::Click { x: 1.0, y: 1.0, button: MouseButton::Left },
			&sup,
			true,
			Some(7),
			9,
		);
		assert_eq!(res, Err(ExecError::DisplayStale));
		assert!(ops.is_empty());
	}

	#[test]
	fn matching_epoch_allows_action() {
		let sup = live_supervisor();
		let (res, ops) = run(
			&InputAction::Click { x: 100.0, y: 50.0, button: MouseButton::Left },
			&sup,
			true,
			Some(7),
			7,
		);
		assert!(res.is_ok());
		assert!(!ops.is_empty());
	}

	#[test]
	fn cursor_warp_failure_maps_through_execute_input() {
		let supervisor = live_supervisor();
		let permissions = FakePerms { granted: true };
		let context = FakeDisplay { epoch: 0 };
		let mut controller = InputController::new(WarpFailSink);
		assert_eq!(
			execute_input(
				&InputAction::Move { x: 1.0, y: 1.0 },
				&supervisor,
				&permissions,
				&context,
				None,
				&display(),
				&mut controller,
				&never_cancel(),
			),
			Err(ExecError::CursorWarpFailed(9))
		);
	}
	#[test]
	fn out_of_bounds_coordinate_errors_and_releases() {
		let sup = live_supervisor();
		// drag to out-of-bounds: press happens then error -> release_all leaves nothing
		// held.
		let action = InputAction::Drag {
			x:      0.0,
			y:      0.0,
			to_x:   999.0,
			to_y:   0.0,
			button: MouseButton::Left,
		};
		let (res, ops) = run(&action, &sup, true, None, 0);
		assert!(matches!(res, Err(ExecError::Coord(_))));
		let downs = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: true, .. }))
			.count();
		let ups = ops
			.iter()
			.filter(|o| matches!(o, SinkOp::Button { down: false, .. }))
			.count();
		assert_eq!(downs, ups, "every press is released after the error path");
	}

	#[test]
	fn type_and_keypress_pass_the_gate() {
		let sup = live_supervisor();
		let (res, ops) = run(&InputAction::Type { text: "hi".to_string() }, &sup, true, None, 0);
		assert!(res.is_ok());
		assert_eq!(ops, vec![SinkOp::TypeUnicode("hi".to_string())]);

		let (res2, ops2) =
			run(&InputAction::Keypress { keys: vec!["enter".to_string()] }, &sup, true, None, 0);
		assert!(res2.is_ok());
		assert_eq!(ops2.len(), 2); // key down + up
	}

	#[test]
	fn wait_zero_is_ok() {
		let sup = live_supervisor();
		let (res, _) = run(&InputAction::Wait { ms: 0 }, &sup, true, None, 0);
		assert!(res.is_ok());
	}

	#[test]
	fn transaction_cancellation_during_wait_prevents_later_input() {
		let supervisor = live_supervisor();
		let permissions = FakePerms { granted: true };
		let context = FakeDisplay { epoch: 0 };
		let mut controller = InputController::new(RecordingSink::default());
		let captured = Rc::new(Cell::new(false));
		let mut hooks =
			RecordingHooks { capture_state: Some(Rc::clone(&captured)), ..RecordingHooks::default() };
		let post_capture_polls = Cell::new(0usize);
		let result = execute_input_transaction(
			&[InputAction::Wait { ms: 50 }, InputAction::Type { text: "must-not-run".to_string() }],
			&supervisor,
			&permissions,
			&context,
			None,
			&display(),
			&mut controller,
			&mut hooks,
			&|| {
				if !captured.get() {
					return false;
				}
				let current = post_capture_polls.get();
				post_capture_polls.set(current + 1);
				current >= 2
			},
		);
		assert_eq!(
			result,
			Err(ExecError::ActionFailed { index: 0, source: Box::new(ExecError::Cancelled) })
		);
		assert_eq!((hooks.captures, hooks.restores), (1, 1));
		assert!(controller.into_sink().ops.is_empty());
	}
	#[test]
	fn transaction_cancellation_during_keypress_stops_later_keys_and_actions() {
		let supervisor = live_supervisor();
		let permissions = FakePerms { granted: true };
		let context = FakeDisplay { epoch: 0 };
		let mut controller = InputController::new(RecordingSink::default());
		let captured = Rc::new(Cell::new(false));
		let mut hooks =
			RecordingHooks { capture_state: Some(Rc::clone(&captured)), ..RecordingHooks::default() };
		let post_capture_polls = Cell::new(0usize);
		let result = execute_input_transaction(
			&[
				InputAction::Keypress { keys: vec!["enter".to_string(), "tab".to_string()] },
				InputAction::Type { text: "must-not-run".to_string() },
			],
			&supervisor,
			&permissions,
			&context,
			None,
			&display(),
			&mut controller,
			&mut hooks,
			&|| {
				if !captured.get() {
					return false;
				}
				let current = post_capture_polls.get();
				post_capture_polls.set(current + 1);
				current >= 3
			},
		);

		assert!(matches!(
			result,
			Err(ExecError::ActionFailed {
				index: 0,
				source
			}) if matches!(*source, ExecError::Cancelled)
		));
		assert_eq!((hooks.captures, hooks.restores), (1, 1));
		assert_eq!(controller.into_sink().ops, vec![
			SinkOp::Key { code: 36, down: true },
			SinkOp::Key { code: 36, down: false },
		]);
	}

	#[test]
	fn transaction_captures_once_and_restore_failure_retains_primary() {
		let supervisor = live_supervisor();
		let permissions = FakePerms { granted: true };
		let context = FakeDisplay { epoch: 0 };
		let mut controller = InputController::new(RecordingSink::default());
		let mut hooks = RecordingHooks { restore_fails: true, ..RecordingHooks::default() };
		let result = execute_input_transaction(
			&[InputAction::Move { x: 999.0, y: 0.0 }],
			&supervisor,
			&permissions,
			&context,
			None,
			&display(),
			&mut controller,
			&mut hooks,
			&never_cancel(),
		);
		assert!(matches!(
			result,
			Err(ExecError::CursorRestoreFailed {
				primary: Some(primary)
			}) if matches!(*primary, ExecError::ActionFailed { index: 0, .. })
		));
		assert_eq!((hooks.captures, hooks.restores), (1, 1));
	}

	#[test]
	fn transaction_capture_failure_runs_no_input_or_restore() {
		let supervisor = live_supervisor();
		let permissions = FakePerms { granted: true };
		let context = FakeDisplay { epoch: 0 };
		let mut controller = InputController::new(RecordingSink::default());
		let mut hooks = RecordingHooks { capture_fails: true, ..RecordingHooks::default() };
		let result = execute_input_transaction(
			&[InputAction::Type { text: "must-not-run".to_string() }],
			&supervisor,
			&permissions,
			&context,
			None,
			&display(),
			&mut controller,
			&mut hooks,
			&never_cancel(),
		);
		assert_eq!(result, Err(ExecError::CursorCaptureFailed));
		assert_eq!((hooks.captures, hooks.restores), (1, 0));
		assert!(controller.into_sink().ops.is_empty());
	}

	#[test]
	fn cancelled_before_transaction_admission_does_not_capture_or_restore() {
		let mut controller = InputController::new(RecordingSink::default());
		let mut hooks = RecordingHooks::default();
		let result =
			super::with_cursor_transaction(&mut controller, &mut hooks, &|| true, |_| Ok(()));
		assert_eq!(result, Err(ExecError::Cancelled));
		assert_eq!((hooks.captures, hooks.restores), (0, 0));
	}

	#[test]
	fn mutex_admission_observes_cancellation_without_capturing_cursor() {
		let _held = super::INPUT_TRANSACTION.lock().unwrap();
		let polls = Cell::new(0usize);
		let mut controller = InputController::new(RecordingSink::default());
		let mut hooks = RecordingHooks::default();
		let result = super::with_cursor_transaction(
			&mut controller,
			&mut hooks,
			&|| {
				let poll = polls.get();
				polls.set(poll + 1);
				poll >= 2
			},
			|_| Ok(()),
		);
		assert_eq!(result, Err(ExecError::Cancelled));
		assert_eq!((hooks.captures, hooks.restores), (0, 0));
	}
	#[test]
	fn transaction_releases_held_input_before_restoring_cursor() {
		let log = Rc::new(RefCell::new(Vec::new()));
		let mut controller = InputController::new(OrderedSink { log: Rc::clone(&log) });
		let mut hooks = OrderedHooks { log: Rc::clone(&log) };
		let result = super::with_cursor_transaction(
			&mut controller,
			&mut hooks,
			&never_cancel(),
			|controller| {
				controller.hold_button_for_test(MouseButton::Left);
				Ok(())
			},
		);
		assert_eq!(result, Ok(()));
		assert_eq!(&*log.borrow(), &["capture", "down", "up", "restore"]);
	}
	#[test]
	fn transaction_panic_releases_held_input_and_restores_cursor() {
		let log = Rc::new(RefCell::new(Vec::new()));
		let mut controller = InputController::new(OrderedSink { log: Rc::clone(&log) });
		let mut hooks = OrderedHooks { log: Rc::clone(&log) };
		let result = super::with_cursor_transaction(
			&mut controller,
			&mut hooks,
			&never_cancel(),
			|controller| -> Result<(), ExecError> {
				controller.hold_button_for_test(MouseButton::Left);
				panic!("injected transaction panic");
			},
		);

		assert_eq!(result, Err(ExecError::TransactionPanicked));
		assert_eq!(&*log.borrow(), &["capture", "down", "up", "restore"]);
	}
	#[test]
	fn release_panic_still_restores_cursor_once() {
		let log = Rc::new(RefCell::new(Vec::new()));
		let mut controller = InputController::new(PanicReleaseSink { log: Rc::clone(&log) });
		let mut hooks = OrderedHooks { log: Rc::clone(&log) };
		let result = super::with_cursor_transaction(
			&mut controller,
			&mut hooks,
			&never_cancel(),
			|controller| {
				controller.hold_button_for_test(MouseButton::Left);
				Ok(())
			},
		);

		assert_eq!(result, Err(ExecError::TransactionPanicked));
		assert_eq!(&*log.borrow(), &["capture", "down", "release-panic", "restore"]);
	}

	#[test]
	fn restore_panic_is_mapped_without_escaping_transaction() {
		let log = Rc::new(RefCell::new(Vec::new()));
		let mut controller = InputController::new(OrderedSink { log: Rc::clone(&log) });
		let mut hooks = PanicRestoreHooks { log: Rc::clone(&log) };
		let result =
			super::with_cursor_transaction(&mut controller, &mut hooks, &never_cancel(), |_| Ok(()));

		assert_eq!(result, Err(ExecError::CursorRestoreFailed { primary: None }));
		assert_eq!(&*log.borrow(), &["capture", "restore-panic"]);
	}
	#[test]
	fn error_codes_are_stable() {
		assert_eq!(ExecError::Suspended.code(), "COMPUTER_SUSPENDED");
		assert_eq!(ExecError::SupervisorNotLive.code(), "COMPUTER_SUPERVISOR_NOT_LIVE");
		assert_eq!(ExecError::PermissionRequired.code(), "COMPUTER_PERMISSION_REQUIRED");
		assert_eq!(ExecError::DisplayStale.code(), "COMPUTER_DISPLAY_STALE");
		assert_eq!(ExecError::CursorWarpFailed(1).code(), "COMPUTER_CURSOR_WARP_FAILED");
		assert_eq!(ExecError::CursorCaptureFailed.code(), "COMPUTER_CURSOR_CAPTURE_FAILED");
		assert_eq!(
			ExecError::CursorRestoreFailed { primary: None }.code(),
			"COMPUTER_CURSOR_RESTORE_FAILED"
		);
		assert_eq!(ExecError::TransactionPoisoned.code(), "COMPUTER_TRANSACTION_FAILED");
		assert_eq!(ExecError::TransactionPanicked.code(), "COMPUTER_TRANSACTION_FAILED");
	}
}
