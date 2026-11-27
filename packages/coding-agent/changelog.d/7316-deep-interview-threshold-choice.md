### Changed

- The `/skill:deep-interview` kickoff now says how to change the ambiguity target, worded for where the current target came from (mode flags, `--threshold`, or the config file that set it), and when nothing chose a target it suggests a mode for the idea with a one-line reason (#7316).

### Fixed

- Activating deep-interview through `/skill:deep-interview` or the `$deep-interview` keyword now seeds the threshold with the CLI precedence: `--threshold` and `--quick`/`--standard`/`--deep` from the invocation, and the configured `gjc.deepInterview.ambiguityThreshold` from the session's own profile. Before, it always recorded `0.05` / `default` (#7316).
