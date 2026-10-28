//! Terminal control utilities for Unix-like systems.
//!
//! Provides safe N-API-exported wrapper over termios operations for clearing
//! ECHO/ECHOCTL/ICANON flags without cycling through cooked mode.

use napi::Result as NapiResult;
use napi_derive::napi;

/// Ensure raw mode by clearing ECHO, ECHOCTL, and ICANON flags on Unix-like
/// systems.
///
/// On Unix, directly clears the specified terminal flags via termios without
/// cycling through cooked mode (which would briefly expose ECHO).
///
/// On non-Unix platforms, does nothing.
///
/// # Returns
/// `Ok(())` on success or if not a TTY, or an error if the termios call fails.
#[napi]
pub fn ensure_raw_mode_via_termios() -> NapiResult<()> {
	#[cfg(target_family = "unix")]
	{
		use std::io::IsTerminal;

		// Check if stdin is a TTY
		if !std::io::stdin().is_terminal() {
			return Ok(());
		}

		unsafe {
			let fd = 0; // stdin file descriptor

			// Get current terminal attributes
			let mut termios: libc::termios = std::mem::zeroed();
			if libc::tcgetattr(fd, &mut termios) != 0 {
				return Err(napi::Error::new(
					napi::Status::GenericFailure,
					format!("tcgetattr failed: {}", std::io::Error::last_os_error()),
				));
			}

			// Clear ECHO, ECHOCTL, and ICANON flags from c_lflag
			// ECHO = 0x0008 (echo input characters)
			// ECHOCTL = 0x0040 (echo control characters as ^X)
			// ICANON = 0x0100 (canonical input)
			const ECHO: libc::tcflag_t = 0x0008;
			const ECHOCTL: libc::tcflag_t = 0x0040;
			const ICANON: libc::tcflag_t = 0x0100;

			termios.c_lflag &= !(ECHO | ECHOCTL | ICANON);

			// Apply the modified settings (TCSANOW = 0 means apply immediately)
			if libc::tcsetattr(fd, libc::TCSANOW, &termios) != 0 {
				return Err(napi::Error::new(
					napi::Status::GenericFailure,
					format!("tcsetattr failed: {}", std::io::Error::last_os_error()),
				));
			}

			Ok(())
		}
	}

	#[cfg(not(target_family = "unix"))]
	Ok(())
}
