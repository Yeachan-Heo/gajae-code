### Fixed

- Allow a fresh ACP prompt to wait for a previously failed or cancelled turn to finish winding down before reporting a busy conflict.
- Admit the next ACP prompt immediately after cancellation settles instead of requiring a retry.
