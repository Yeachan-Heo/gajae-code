### Fixed

- Crash redaction now recognizes `pw` password fields, scrubbing credential suffixes attached to single-quoted placeholders while preserving standalone placeholders and following fields. New crash records use fingerprint version 2; recovery preserves v1 marker verification with the historical normalizer.
