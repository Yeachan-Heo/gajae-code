### Fixed

- macOS + Warp OSC 11 probe echo after sleep/wake: raw mode is now re-asserted via direct termios manipulation (on Unix-like systems) to clear ECHO/ECHOCTL flags without cycling through cooked mode, which was the root cause of probe replies being echoed to the screen.
