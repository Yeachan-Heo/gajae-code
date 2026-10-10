### Fixed

- Configured secrets in unsigned thinking text, its summary and raw siblings, and tool-call arguments are replaced before those messages leave the process, including a secret that is an entire JSON value or only an object key, and a signed thinking block, opaque redacted-thinking block, or replayed Responses reasoning item that contains a secret is omitted instead of being rewritten under its provider signature.
