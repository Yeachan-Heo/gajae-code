### Fixed

- The SSH tool frames remote command output in its direct result and error text, and a shorter inline window keeps that frame. Reading an SSH output artifact wraps the selected text after selection and truncation; stored artifact bytes remain unchanged.
- A rejected artifact reservation after the remote command has finished still returns that command's framed output and exit status.
