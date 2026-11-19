### Fixed

- Korean-layout Ctrl+V (and other modified Hangul-jamo keys) sent as CSI-u now match their bindings when the Kitty keyboard protocol is off, so image paste works with `GJC_TUI_KEYBOARD_PROTOCOL=0` in iTerm2 with "Report modifiers using CSI u" enabled.
