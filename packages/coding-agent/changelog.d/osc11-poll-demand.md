### Changed

- Interactive mode re-queries the terminal background (OSC 11) only while the answer can change the theme: auto-detection is active and `theme.dark` and `theme.light` differ. An idle session with one theme in both slots, or with an explicitly picked theme, no longer writes a probe to a terminal without Mode 2031 every 2 seconds.
