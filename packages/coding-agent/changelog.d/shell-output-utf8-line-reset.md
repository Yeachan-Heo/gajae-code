### Fixed

- On Windows with CJK ANSI code page, bash tool output with one invalid UTF-8 byte no longer permanently switches to ACP decoding for the rest of the stream. Each line is now independently decoded, so an encoding error on one line no longer corrupts later valid UTF-8 lines (#7861).
