### Fixed

- macOS machine identity lookup invokes `/usr/sbin/ioreg` directly instead of depending on it being present in `PATH`; a missing executable now reports identity as unavailable rather than leaking a spawn `ENOENT` error.
