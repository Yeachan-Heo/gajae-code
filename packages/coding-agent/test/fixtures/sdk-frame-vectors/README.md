# SDK frame conformance vectors

Every `*.json` document is consumed by both the TypeScript and Python vector suites. The required fields are `$schema: "sdk-frame-vectors/v1"`, a descriptive `name`, `kind`, and an `expectations` object.

- `kind: "frame"` contains `frame` (a JSON object) or `rawFrame` (opaque JSON text). `rawFrame` bytes must traverse a relay unchanged, except for the JSONL LF at a line boundary.
- `kind: "record"` contains one or more protocol records (`frames`, `lines`, or `staleDiscovery`).
- `kind: "generator"` contains `prefix`, `suffix`, and `generate` with a one-character `character` and non-negative integer `count`. Consumers expand `prefix + character.repeat(count) + suffix`, verify byte length from `expectations.minimumBytes` when present, then parse it as JSON.

Frames intentionally tolerate key ordering, insignificant whitespace, escaped Unicode, and unknown fields. New vector files are automatically picked up by both suites.
