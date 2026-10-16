### Fixed

- Crash redaction now parses escaped single- and double-quote delimiters in serialized credential containers, preventing closing braces or brackets inside quoted values from exposing later secrets.
