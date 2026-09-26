### Changed

- Re-synced native `grep`, `search`, and `hasMatch` with the pinned walker-based implementation. Regex lookarounds and backreferences use a statically bundled PCRE2 build (`PCRE2_SYS_STATIC=1`), so the addon has no dynamic PCRE2 runtime dependency. The existing grep result shape and cached serial fallback are retained; the upstream-only injectable shell filesystem option is omitted because GJC has no caller for it.
