### Fixed

- A cursor position report that an outer PTY proxy (for example ghost-complete) leaks into GJC is no longer taken as input, so it stops snapping a scrolled-up transcript back to the bottom. GJC never requests these reports. `CSI 1;<modifier> R` is still delivered as modified F3.
