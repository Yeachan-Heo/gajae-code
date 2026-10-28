//! Terminal control utilities for Unix-like systems.
//!
//! Provides an N-API wrapper over termios that clears ECHO/ECHOCTL/ICANON
//! without cycling through cooked mode.

use napi::Result as NapiResult;
use napi_derive::napi;

/// Clear ECHO, ECHOCTL and ICANON on stdin without passing through cooked mode.
///
/// Returns `Ok(())` when stdin is not a TTY or on non-Unix platforms, and an
/// error when `tcgetattr`/`tcsetattr` fails.
#[napi]
pub fn ensure_raw_mode_via_termios() -> NapiResult<()> {
	#[cfg(target_family = "unix")]
	{
		use std::io::IsTerminal;

		if !std::io::stdin().is_terminal() {
			return Ok(());
		}
		clear_echo_flags(libc::STDIN_FILENO)
			.map_err(|err| napi::Error::new(napi::Status::GenericFailure, err.to_string()))?;
	}
	Ok(())
}

/// Clear ECHO, ECHOCTL and ICANON on `fd`, using libc's per-platform flag
/// values and `struct termios` layout.
#[cfg(target_family = "unix")]
fn clear_echo_flags(fd: libc::c_int) -> std::io::Result<()> {
	// SAFETY: `termios` is fully initialized by a successful tcgetattr before use.
	unsafe {
		let mut termios: libc::termios = std::mem::zeroed();
		if libc::tcgetattr(fd, &mut termios) != 0 {
			return Err(std::io::Error::last_os_error());
		}
		termios.c_lflag &= !(libc::ECHO | libc::ECHOCTL | libc::ICANON);
		if libc::tcsetattr(fd, libc::TCSANOW, &termios) != 0 {
			return Err(std::io::Error::last_os_error());
		}
	}
	Ok(())
}

#[cfg(all(test, target_family = "unix"))]
mod tests {
	use super::clear_echo_flags;

	fn lflag(fd: libc::c_int) -> libc::tcflag_t {
		// SAFETY: tcgetattr fills the zeroed struct; the result is checked.
		unsafe {
			let mut termios: libc::termios = std::mem::zeroed();
			assert_eq!(libc::tcgetattr(fd, &mut termios), 0);
			termios.c_lflag
		}
	}

	#[test]
	fn clears_echo_echoctl_icanon_on_a_real_pty() {
		let mut master: libc::c_int = -1;
		let mut slave: libc::c_int = -1;
		// SAFETY: openpty writes two fds; null name/termp/winp are allowed.
		let opened = unsafe {
			libc::openpty(
				&mut master,
				&mut slave,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
			)
		};
		assert_eq!(opened, 0, "openpty failed: {}", std::io::Error::last_os_error());

		// SAFETY: slave is a valid pty fd from openpty.
		unsafe {
			let mut termios: libc::termios = std::mem::zeroed();
			assert_eq!(libc::tcgetattr(slave, &mut termios), 0);
			termios.c_lflag |= libc::ECHO | libc::ECHOCTL | libc::ICANON | libc::ISIG;
			assert_eq!(libc::tcsetattr(slave, libc::TCSANOW, &termios), 0);
		}

		clear_echo_flags(slave).expect("clear_echo_flags");
		let after = lflag(slave);
		assert_eq!(after & (libc::ECHO | libc::ECHOCTL | libc::ICANON), 0);
		// Unrelated flags are left alone.
		assert_ne!(after & libc::ISIG, 0);

		// SAFETY: closing fds we own.
		unsafe {
			libc::close(slave);
			libc::close(master);
		}
	}
}
