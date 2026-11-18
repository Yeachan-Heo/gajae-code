### Fixed

- A repeated unclosed private-key banner no longer stalls scrubbing. A complete block is still replaced.
- Credential-container scanning is work-bounded, so repeated unclosed `secret={` lines no longer rescan the remaining text each time. A container that closes near the end of the bound is still found, and the line lookup advances forward instead of rescanning the suffix per container.
- A private-key block and a credential container that hold each other are now located on the same text before either is masked. Removing the block first erased the `secret={` the container starts at, so the container's remaining members survived; masking the container first erased a footer the block still had to pair. The block is read again on the masked text, so a container or a YAML block scalar that hides the first footer no longer leaves the text before the next footer visible.

### Changed

- `redactStructuredSecrets` only reads a flat name/value array or a `{ name, value }` record as header pairs when the caller opts in, by boolean or by a field-name predicate such as the new `isHeaderCollectionKey`, so ordinary data keeps its values.
- `redactStructuredSecrets` takes a `resolveKey` hook so a caller that decodes names before serializing classifies the credential test, the header-collection test and the header-record member roles by the decoded name. Callers that pass no hook keep the name as given.
