### Fixed

- Crash redaction now fully masks credentials wrapped in backslash-escaped backticks, including values nested in serialized containers and authorization headers, while preserving following diagnostics.
