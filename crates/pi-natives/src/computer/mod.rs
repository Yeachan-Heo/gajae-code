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

/// Kernel-backed macOS process identity used to prevent PID-reuse signaling.
#[napi(object)]
pub struct DarwinProcessIdentity {
	/// Microsecond-resolution process start token (`seconds:microseconds`).
	pub start_token: String,
	/// Canonical executable path reported by `proc_pidpath`.
	pub executable:  String,
	/// Process group identifier.
	pub pgid:        i32,
}

/// Return the kernel-backed incarnation identity for a macOS process.
#[napi(js_name = "darwinProcessIdentity")]
pub fn darwin_process_identity(pid: i32) -> napi::Result<DarwinProcessIdentity> {
	#[cfg(target_os = "macos")]
	{
		if pid <= 0 {
			return Err(napi::Error::new(
				napi::Status::InvalidArg,
				"Process ID must be positive".to_string(),
			));
		}

		let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
		let info_size = i32::try_from(std::mem::size_of::<libc::proc_bsdinfo>())
			.map_err(|_| napi::Error::from_reason("unable to read process identity"))?;
		// SAFETY: `info` is writable for exactly `info_size` bytes and remains valid
		// for the duration of this synchronous kernel query.
		let read = unsafe {
			libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, info.as_mut_ptr().cast(), info_size)
		};
		if read != info_size {
			return Err(napi::Error::from_reason("unable to read process identity"));
		}
		// SAFETY: exact-size `proc_pidinfo` success initialized the structure.
		let info = unsafe { info.assume_init() };
		let expected_pid = u32::try_from(pid)
			.map_err(|_| napi::Error::from_reason("unable to read process identity"))?;
		if info.pbi_pid != expected_pid || info.pbi_pgid == 0 {
			return Err(napi::Error::from_reason("unable to read process identity"));
		}

		let mut executable = vec![0_u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
		// SAFETY: `executable` is writable for its declared capacity and the kernel
		// writes at most that many bytes.
		let path_len = unsafe {
			libc::proc_pidpath(
				pid,
				executable.as_mut_ptr().cast(),
				u32::try_from(executable.len())
					.map_err(|_| napi::Error::from_reason("unable to read process identity"))?,
			)
		};
		if path_len <= 0 {
			return Err(napi::Error::from_reason("unable to read process identity"));
		}
		let path_len = usize::try_from(path_len)
			.map_err(|_| napi::Error::from_reason("unable to read process identity"))?;
		if path_len > executable.len() {
			return Err(napi::Error::from_reason("unable to read process identity"));
		}
		let end = executable[..path_len]
			.iter()
			.position(|byte| *byte == 0)
			.unwrap_or(path_len);
		let executable = String::from_utf8(executable[..end].to_vec())
			.map_err(|_| napi::Error::from_reason("unable to read process identity"))?;
		if executable.is_empty() {
			return Err(napi::Error::from_reason("unable to read process identity"));
		}

		Ok(DarwinProcessIdentity {
			start_token: format!("{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec),
			executable,
			pgid: i32::try_from(info.pbi_pgid)
				.map_err(|_| napi::Error::from_reason("unable to read process identity"))?,
		})
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = pid;
		Err(napi::Error::from_reason("Process identity lookup is only supported on macOS"))
	}
}

/// Return the process ID of the peer connected to a Unix-domain socket (macOS).
///
/// The kernel resolves the peer from the connected socket descriptor; this
/// never falls back to the current process ID or another inferred identity.
#[napi(js_name = "unixSocketPeerPid")]
pub fn unix_socket_peer_pid(fd: i32) -> napi::Result<i32> {
	#[cfg(target_os = "macos")]
	{
		if fd < 0 {
			return Err(napi::Error::new(
				napi::Status::InvalidArg,
				"Unix socket file descriptor must be nonnegative".to_string(),
			));
		}

		let expected_len = libc::socklen_t::try_from(std::mem::size_of::<libc::pid_t>())
			.map_err(|_| napi::Error::from_reason("unable to read Unix socket peer PID"))?;
		let mut peer_pid: libc::pid_t = 0;
		let mut peer_pid_len = expected_len;
		// SAFETY: `peer_pid` is writable for `peer_pid_len` bytes, and both pointers
		// remain valid for the duration of this synchronous system call.
		let status = unsafe {
			libc::getsockopt(
				fd,
				libc::SOL_LOCAL,
				libc::LOCAL_PEERPID,
				(&mut peer_pid as *mut libc::pid_t).cast(),
				&mut peer_pid_len,
			)
		};
		if status != 0 || peer_pid_len != expected_len {
			return Err(napi::Error::from_reason("unable to read Unix socket peer PID"));
		}

		let peer_pid = i32::try_from(peer_pid)
			.map_err(|_| napi::Error::from_reason("unable to read Unix socket peer PID"))?;
		if peer_pid <= 0 {
			return Err(napi::Error::from_reason("unable to read Unix socket peer PID"));
		}
		Ok(peer_pid)
	}
	#[cfg(not(target_os = "macos"))]
	{
		let _ = fd;
		Err(napi::Error::from_reason("Unix socket peer PID lookup is only supported on macOS"))
	}
}
