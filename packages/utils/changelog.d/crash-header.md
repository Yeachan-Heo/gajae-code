### Fixed

- Crash logs redact a stack before splitting it. When the stack starts with `name: message`, or with a name-only header for an empty message, and no credential replacement crosses that boundary, only the header is flattened and later frame lines stay. If a credential crosses the boundary, or the stack has another shape, the redacted stack is one field so the credential is still removed. The record fingerprint is computed from that stored diagnostic, so recovery can rebind it.
