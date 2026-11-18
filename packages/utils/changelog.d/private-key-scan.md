### Fixed

- A repeated unclosed private-key banner no longer stalls scrubbing. A complete block is still replaced.
- Credential-container scanning is work-bounded, so repeated unclosed `secret={` lines no longer rescan the remaining text each time. A container that closes near the end of the bound is still found, and the line lookup advances forward instead of rescanning the suffix per container.
- Current crash output now classifies once and applies once. Private-key blocks, credential containers, URL userinfo, YAML block scalars and the line-bounded rules are all collected from the original text and replaced through one `applyRedactions` call, so no rule reads text another rule produced. The historical v1 rules stay sequential and separate for fingerprint validation only.
- Private-key banners pair with the nearest opener before a footer (LIFO), so an opener that sits inside a credential container or YAML body does not pair forward past the real block and swallow the diagnostics in between. An unclosed banner still cannot stall a scan.
- URL userinfo is masked before the Bearer/Basic/Token rule in the same pass. The auth-token rule no longer consumes a scheme word (`Token postgres://…` keeps `postgres://` readable) or a following diagnostic, and it is attempted one physical line at a time.
- When the credential-container scan runs out of lookahead, the whole text becomes one redaction marker. Masking only the remaining suffix kept a prefix whose later-rule inputs were gone: the footer a private-key block pairs with, the `@` that ends a URL's userinfo. Losing the diagnostics of text already dominated by unclosed containers is the price of a cutoff that holds for every later rule.

### Changed

- Detection reads a branded `OriginalText` and returns ranges; `applyRedactions` is the only function that produces `RedactedText`. A `RedactedText` is not assignable to `OriginalText`, so feeding masked output back into a detector is a type error rather than a silent reclassification.
- `findCredentialContainerSpans` reports the credential-container ranges of the text it is given without mutating it, so a caller that also detects private-key blocks can apply both to its original text in one pass.
- `findUrlCredentialSpans` reports only the userinfo range of a URL, so a caller can keep the scheme and host printed while masking the credential.
- `findYamlBlockScalarSpans` reports the printed body ranges of credential-named block scalars and stops a body discovered inside a credential container at that container's close, so unrelated text after the container survives.
- `redactStructuredSecrets` only reads a flat name/value array or a `{ name, value }` record as header pairs when the caller opts in, by boolean or by a field-name predicate such as the new `isHeaderCollectionKey`, so ordinary data keeps its values.
- `redactStructuredSecrets` takes a `resolveKey` hook so a caller that decodes names before serializing classifies the credential test, the header-collection test and the header-record member roles by the decoded name. Callers that pass no hook keep the name as given.
