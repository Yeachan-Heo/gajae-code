### Fixed

- A repeated unclosed private-key banner no longer stalls scrubbing. A complete block is still replaced.
- Credential-container scanning is work-bounded, so repeated unclosed `secret={` lines no longer rescan the remaining text each time. A container that closes near the end of the bound is still found, and the line lookup advances forward instead of rescanning the suffix per container.

### Changed

- `redactStructuredSecrets` only reads flat name/value arrays as header pairs when the caller opts in, by boolean or by a field-name predicate such as the new `isHeaderCollectionKey`, so an ordinary argument array keeps its values.
