### Fixed

- The ssh tool now uses the same ACP and SDK permission gate as bash. Prompt mode asks before a remote command runs, and deny mode rejects it. Allow mode is unchanged, and tool names outside that gate still run without a prompt.
