### Fixed

- `gjc plugin upgrade` now detects new releases of marketplace plugins whose catalog entry omits `version` by reading the plugin's own manifest, instead of reporting them as up to date (#7784).
