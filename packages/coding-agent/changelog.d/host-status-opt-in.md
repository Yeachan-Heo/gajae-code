### Fixed

- Interactive turn status markers are opt-in. The emitted `ESC ] 777 ; notify;Terax;...` sequence is the rxvt notification extension, so Ghostty and cmux raised a desktop notification titled `Terax` on every turn start and finish. A host now sets `GJC_HOST_STATUS=terax` to receive them, and unmarked terminals get no bytes at all.
