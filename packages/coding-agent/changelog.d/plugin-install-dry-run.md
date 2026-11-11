### Fixed

- `gjc plugin install --dry-run` now correctly previews the install without copying the bundle or writing a registry entry. Previously, `--dry-run` performed the install anyway, and running it a second time would fail with "already installed". The preview can now be run multiple times and returns the same result without mutating the filesystem.
