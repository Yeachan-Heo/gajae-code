### Fixed

- On macOS, pressing a bound Option shortcut in a terminal that sends Option as text (Ghostty's default, Terminal.app and iTerm2 without Option-as-Meta) no longer fails silently. The composed character (for example `œ` for the default Option+Q queue shortcut) is still inserted, and GJC now shows a one-time warning naming the setting to change for Ghostty, Terminal.app or iTerm2. The STT setup guidance names the same settings.
