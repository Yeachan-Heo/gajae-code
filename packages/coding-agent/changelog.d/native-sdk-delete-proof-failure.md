### Fixed

- Keep managed cleanup pending when the post-dispatch original-transcript proof fails, including canonical symlink or directory substitution. Restore the native I/O refusal classification only after positive exact identity proof, preserving durable pending evidence and refusing foreign-path retries without effects.
