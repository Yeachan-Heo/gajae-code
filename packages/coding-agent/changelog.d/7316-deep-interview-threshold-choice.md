### Changed

- The `/skill:deep-interview` kickoff now says how to change the ambiguity target (`--quick` / `--standard` / `--deep` / `--threshold`, or `gjc.deepInterview.ambiguityThreshold`), and when nothing chose a target it suggests a mode for the idea with a one-line reason (#7316).

### Fixed

- Activating deep-interview through the skill hook now seeds the configured `gjc.deepInterview.ambiguityThreshold` and its source instead of always recording `0.05` / `default` (#7316).
