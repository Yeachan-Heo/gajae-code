//! In-place raw-mode re-assertion for the TUI's controlling tty.
//!
//! Bun caches the last raw mode it was asked for. A foreground child (ssh,
//! sudo, a pager) can change the shared tty's termios directly and leave it
//! cooked, and after that `setRawMode(true)` does nothing. Cycling
//! `setRawMode(false)` → `setRawMode(true)` forces a real apply, but it is
//! unsafe on Unix. Each call is `tcsetattr(TCSADRAIN)`, which blocks until
//! queued output has drained. The `false` step leaves the tty in cooked mode
//! with `ECHO` on for that whole wait. If a terminal reply to a capability
//! probe arrives during it, the line discipline echoes the reply onto the
//! screen instead of delivering it as input (issue #7373).
//!
//! [`reassert_raw_tty`] reads the live termios and applies the same raw
//! transform with `TCSANOW`, so the tty never enters an echoing state.

use napi::{Error, Result};
use napi_derive::napi;

/// Re-apply raw mode to `fd` when a direct termios change left it cooked.
///
/// Applies the transform Bun's `setRawMode(true)` uses (libuv's
/// `UV_TTY_MODE_RAW`) to the live termios with `TCSANOW`, so the tty never
/// enters an echoing mode. Returns `true` when it had to restore raw mode.
/// Returns `false` when the tty was already raw, and in that case issues no
/// `tcsetattr`. Throws when `fd` is not a tty and on non-Unix hosts.
#[napi]
pub fn reassert_raw_tty(fd: i32) -> Result<bool> {
	#[cfg(unix)]
	{
		reassert_raw(fd)
			.map_err(|err| Error::from_reason(format!("reassertRawTty({fd}) failed: {err}")))
	}
	#[cfg(not(unix))]
	{
		let _ = fd;
		Err(Error::from_reason("reassertRawTty is unix-only"))
	}
}

/// libuv's `UV_TTY_MODE_RAW` transform, the one Bun's `setRawMode(true)`
/// applies. Unlike `cfmakeraw`, it keeps `OPOST`, so `\n` still renders as
/// CRLF.
#[cfg(unix)]
const fn make_raw(termios: &mut libc::termios) {
	termios.c_iflag &= !(libc::BRKINT | libc::ICRNL | libc::INPCK | libc::ISTRIP | libc::IXON);
	termios.c_oflag |= libc::ONLCR;
	termios.c_cflag |= libc::CS8;
	termios.c_lflag &= !(libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG);
	termios.c_cc[libc::VMIN] = 1;
	termios.c_cc[libc::VTIME] = 0;
}

/// Compares exactly the fields [`make_raw`] writes.
#[cfg(unix)]
const fn same_raw_fields(a: &libc::termios, b: &libc::termios) -> bool {
	a.c_iflag == b.c_iflag
		&& a.c_oflag == b.c_oflag
		&& a.c_cflag == b.c_cflag
		&& a.c_lflag == b.c_lflag
		&& a.c_cc[libc::VMIN] == b.c_cc[libc::VMIN]
		&& a.c_cc[libc::VTIME] == b.c_cc[libc::VTIME]
}

#[cfg(unix)]
fn reassert_raw(fd: libc::c_int) -> std::io::Result<bool> {
	let current = tcgetattr(fd)?;
	let mut raw = current;
	make_raw(&mut raw);
	if same_raw_fields(&current, &raw) {
		return Ok(false);
	}
	tcsetattr_now(fd, &raw)?;
	Ok(true)
}

#[cfg(unix)]
fn tcgetattr(fd: libc::c_int) -> std::io::Result<libc::termios> {
	// SAFETY: an all-zero `termios` is a valid out-parameter; a successful
	// `tcgetattr` initializes every field before it is read.
	let mut termios: libc::termios = unsafe { std::mem::zeroed() };
	loop {
		// SAFETY: `termios` is a live, writable `struct termios` for the call.
		if unsafe { libc::tcgetattr(fd, &mut termios) } == 0 {
			return Ok(termios);
		}
		let err = std::io::Error::last_os_error();
		if err.kind() != std::io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

#[cfg(unix)]
fn tcsetattr_now(fd: libc::c_int, termios: &libc::termios) -> std::io::Result<()> {
	loop {
		// SAFETY: `termios` is a fully initialized `struct termios` from `tcgetattr`.
		if unsafe { libc::tcsetattr(fd, libc::TCSANOW, termios) } == 0 {
			return Ok(());
		}
		let err = std::io::Error::last_os_error();
		if err.kind() != std::io::ErrorKind::Interrupted {
			return Err(err);
		}
	}
}

#[cfg(all(test, unix))]
mod tests {
	use super::{reassert_raw, tcgetattr, tcsetattr_now};

	struct Pty {
		master: libc::c_int,
		slave:  libc::c_int,
	}

	impl Pty {
		fn open() -> Self {
			let mut master: libc::c_int = -1;
			let mut slave: libc::c_int = -1;
			// SAFETY: `openpty` writes two fds; null name/termios/winsize are allowed.
			let rc = unsafe {
				libc::openpty(
					&mut master,
					&mut slave,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null_mut(),
				)
			};
			assert_eq!(rc, 0, "openpty failed: {}", std::io::Error::last_os_error());
			Self { master, slave }
		}
	}

	impl Drop for Pty {
		fn drop(&mut self) {
			// SAFETY: both fds come from `openpty` and are owned by this value.
			unsafe {
				libc::close(self.slave);
				libc::close(self.master);
			}
		}
	}

	/// What a foreground child such as `stty sane` leaves behind.
	fn make_cooked(fd: libc::c_int) {
		let mut termios = tcgetattr(fd).expect("tcgetattr");
		termios.c_iflag |= libc::BRKINT | libc::ICRNL | libc::IXON;
		termios.c_oflag |= libc::OPOST | libc::ONLCR;
		termios.c_lflag |= libc::ECHO | libc::ECHOCTL | libc::ICANON | libc::IEXTEN | libc::ISIG;
		tcsetattr_now(fd, &termios).expect("tcsetattr");
	}

	#[test]
	fn restores_raw_mode_on_a_cooked_pty() {
		let pty = Pty::open();
		make_cooked(pty.slave);

		assert!(reassert_raw(pty.slave).expect("reassert"));

		let after = tcgetattr(pty.slave).expect("tcgetattr");
		assert_eq!(after.c_lflag & (libc::ECHO | libc::ICANON | libc::IEXTEN | libc::ISIG), 0);
		assert_eq!(after.c_iflag & (libc::BRKINT | libc::ICRNL | libc::IXON), 0);
		assert_eq!(after.c_cc[libc::VMIN], 1);
		assert_eq!(after.c_cc[libc::VTIME], 0);
		// Output processing is untouched, so `\n` keeps rendering as CRLF.
		assert_ne!(after.c_oflag & libc::OPOST, 0);
		assert_ne!(after.c_oflag & libc::ONLCR, 0);
	}

	#[test]
	fn leaves_an_already_raw_pty_alone() {
		let pty = Pty::open();
		make_cooked(pty.slave);
		assert!(reassert_raw(pty.slave).expect("first reassert"));
		let raw = tcgetattr(pty.slave).expect("tcgetattr");

		assert!(!reassert_raw(pty.slave).expect("second reassert"));

		let after = tcgetattr(pty.slave).expect("tcgetattr");
		assert_eq!(after.c_lflag, raw.c_lflag);
		assert_eq!(after.c_iflag, raw.c_iflag);
	}

	#[test]
	fn rejects_a_non_tty_fd() {
		let mut fds = [-1 as libc::c_int; 2];
		// SAFETY: `pipe` writes two fds into the two-element array.
		assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);

		let err = reassert_raw(fds[0]).expect_err("a pipe is not a tty");
		assert_eq!(err.raw_os_error(), Some(libc::ENOTTY));

		// SAFETY: both fds come from `pipe` and are owned here.
		unsafe {
			libc::close(fds[0]);
			libc::close(fds[1]);
		}
	}
}
