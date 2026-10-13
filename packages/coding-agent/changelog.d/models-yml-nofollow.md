### Fixed

- Saving a custom model profile refuses a symlink at `models.yml`, creates the file as owner-only (`0600`), and creates a missing parent directory as mode `0700`.
