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

#[cfg(target_os = "macos")]
pub mod capture;
pub mod coords;
#[cfg(target_os = "macos")]
pub mod hotkey;
pub mod input;
#[cfg(target_os = "macos")]
pub mod permissions;
pub mod supervisor;

#[cfg(target_os = "macos")]
pub use capture::{CaptureError, CapturedFrame, capture_primary_display};
pub use coords::{CoordError, LogicalPoint, NormalizedDisplay};
pub use input::{EventSink, InputController, InputError, MouseButton};
#[cfg(target_os = "macos")]
pub use permissions::{PermissionError, PreflightStatus, TccPermission, preflight};
pub use supervisor::{Supervisor, SupervisorStatus};
