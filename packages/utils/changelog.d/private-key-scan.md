### Fixed

- A repeated unclosed private-key banner no longer stalls scrubbing. A complete block is still replaced.
- Credential-container scanning is work-bounded, so repeated unclosed `secret={` lines no longer rescan the remaining text each time. A container that closes near the end of the bound is still found, and the line lookup advances forward instead of rescanning the suffix per container.
- Private-key blocks are located and masked in one forward pass in the same rule position as before: credential containers, YAML block scalars and line-bounded values are masked first, so a footer they consume can never end a pairing.
- When the credential-container scan runs out of lookahead, the whole text becomes one redaction marker. Masking only the remaining suffix kept a prefix whose later-rule inputs were gone: the footer a private-key block pairs with, the `@` that ends a URL's userinfo. Losing the diagnostics of text already dominated by unclosed containers is the price of a cutoff that holds for every later rule.

### Changed

- `redactStructuredSecrets` only reads a flat name/value array or a `{ name, value }` record as header pairs when the caller opts in, by boolean or by a field-name predicate such as the new `isHeaderCollectionKey`, so ordinary data keeps its values.
- `redactStructuredSecrets` takes a `resolveKey` hook so a caller that decodes names before serializing classifies the credential test, the header-collection test and the header-record member roles by the decoded name. Callers that pass no hook keep the name as given.
