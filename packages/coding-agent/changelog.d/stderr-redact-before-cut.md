### Fixed

- Crash reports scrub stderr with the existing crash redactor before the preview is trimmed to 4096 bytes, so a token that sits in that window is not stored.
