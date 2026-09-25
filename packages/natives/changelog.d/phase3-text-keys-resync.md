### Fixed

- Prevent the synthetic N-API UTF-16 terminator from leaking into padded truncation output for non-ASCII text. Preserve the GJC two-cell width contract for Hangul compatibility jamo and U+3164.
- Re-sync key handling with pinned upstream: keep Alt+B/F navigation aliases in legacy mode while treating them as literal Alt keys in Kitty mixed mode, recognize keypad digits when NumLock metadata is omitted, avoid mapping unmodified non-Latin text to its physical base-layout shortcut, and accept the legacy Ctrl+- encoding.
