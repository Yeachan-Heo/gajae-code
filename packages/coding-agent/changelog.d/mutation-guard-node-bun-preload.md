### Fixed

- Planning-only phases now fail closed for Node/Bun module-preload flags (`-r`, `--require`, `--import`, `--loader`, `--experimental-loader`, `--preload`) in every detached, attached, equals, and shell-quoted spelling, instead of scanning the one-liner while an unscanned preload module ran first.
