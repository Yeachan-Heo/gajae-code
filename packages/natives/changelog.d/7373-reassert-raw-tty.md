### Added

- Added Unix-only `reassertRawTty(fd)`. It applies the `setRawMode(true)` raw transform (libuv `UV_TTY_MODE_RAW`) to the live termios with `TCSANOW`, so the tty never enters an echoing state. It returns `true` when it had to restore raw mode, returns `false` without calling `tcsetattr` when the tty is already raw, and throws when `fd` is not a tty.
