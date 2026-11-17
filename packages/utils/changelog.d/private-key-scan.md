### Fixed

- A repeated unclosed private-key banner no longer stalls scrubbing. A complete block is still replaced.
- Credential-container scanning is work-bounded, so repeated unclosed `secret={` lines no longer rescan the remaining text each time.

### Changed

- `redactStructuredSecrets` only reads flat name/value arrays as header pairs when the caller opts in, so an ordinary argument array keeps its values.
