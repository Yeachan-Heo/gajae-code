### Fixed
- gjc now fails with a clear operator error instead of a raw stack trace when the home directory or config directory is not writable during startup. The error message names the GJC_CONFIG_DIR environment variable as an override option.
