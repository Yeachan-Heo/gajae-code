### Fixed
- Turn status is no longer announced to terminals that are not Terax. The OSC 777 `notify;` marker is now emitted only when the hosting terminal identifies itself with `TERAX_TERMINAL`, which stopped Ghostty (and other rxvt-compatible terminals) from raising a desktop notification titled "Terax" on every turn.
