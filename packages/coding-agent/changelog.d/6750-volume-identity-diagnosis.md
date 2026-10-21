### Fixed

- A managed session directory that comes back with the same inode on a different volume (after a remount, drive-letter change or volume-serial change) is still refused, but now reports `volume_identity_changed` instead of the generic `Managed write protocol setup failed.` ([#6750](https://github.com/Yeachan-Heo/gajae-code/issues/6750))
