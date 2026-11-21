### Fixed

- Session dump text scrubs credential-shaped tokens before it is copied or printed.
- Session dump tool arguments keep the generated `<parameter>` markup out of the secret scrubber, so a masked value no longer swallows the closing tag.
- Session dump tool schema definitions keep property names, types, and constraints; only literal data (`default`, `example`, `examples`, `const`) under a credential-named property is masked.
- A schema default that only becomes a credential-shaped token after `\u` decoding is redacted as well.
- Credential-shaped tokens split across sibling tool-argument fields, including a credential-named field or a nested argument object, are removed before that field is masked.
- An ordinary tool-argument array such as `["auth", "src"]` and an ordinary `{ name, value }` record are no longer read as header pairs, while a known header collection keeps its value redaction.
- A private-key block split across a Bash or Python command and its output is removed even when the command assigns it to a credential-named variable, or when the block's closing banner sits inside that credential container.
- A private-key block that a tool argument passes through a numeric, boolean, or null argument is removed together with those printed characters, while a number outside the block keeps its own printed form.
- A nested credential-named argument key that is only recognizable after `\u` decoding masks its value, so an escaped PEM block or credential value no longer survives the export. A name another field already holds keeps its own spelling, so neither argument is renamed, dropped or reordered, and an encoded tab inside a credential name still classifies like the tab itself.
- A private-key block that starts before a credential container and ends inside it now masks the container's remaining members too, on both the single-block and the adjacent-run pairing paths. The block and the container are detected on the original text and applied in one pass, so replacing the block can no longer delete the assignment that let the container pass find the rest.
- A header collection is classified from the original slot types, so a private-key block that covers a numeric slot can no longer turn a mixed array into a name/value list and print a credential header record's value.
- A sparse array counts a hole as the `null` it prints in both the detection and the application walk, so a block split past a hole no longer shifts the masks onto the surrounding values.
- A URL password after a Bearer/Basic/Token prefix is removed from the dump. The auth-token rule used to consume the scheme word, leaving `://user:password@host` without an authority the URL rule recognized; the userinfo is now detected on the original text and masked in the same pass, while the scheme and host stay readable. A trailing diagnostic on the same line (`Token postgres://… diagnostic=keep`) is not consumed either.
- A tool-argument name is scrubbed through the same original-text detection as its value, so a name shaped like a credential container whose footer sits inside a private-key block can no longer print the banner and body inside `<parameter name="...">`.
- A credential-container mask that removes the unindented lines of a YAML block scalar no longer causes the remaining indented lines to be re-read as the scalar. The credential-named YAML body is detected on the original text and masked in the same pass, and a scalar discovered inside a container cannot extend past the container's closing bracket, so a line outside every detected range (for example the `keep-me` line after a container) survives and the output is still parseable YAML.
- A YAML block-scalar header found inside a quoted container value under an ordinary, non-credential key is treated as data. It no longer starts a body scan that overwrites the surrounding document's comment and closing quote, so `# keep-me` survives verbatim and the emitted document parses as YAML.
- A quoted YAML mapping key (`"wrapper": […]`) now bounds the same container as a bare key, so a fake header inside its quoted value no longer consumes the closing quote and comment.
- A comment line shaped like a container assignment (`# wrapper: ["ignored` …) no longer opens a container that hides the real block scalar below it, so the credential body is masked and the surrounding text is printed verbatim.
- Session dump metadata, tool names, invoke names, custom types, branch ids and file paths now go through the same original-text detection pass as body content. The single-boundary rule covers the whole dump, not just structured body content.
- Every mask in a rendered schema carries a `#<path>` suffix. A marker is only ever longer than its base form; masking strength is never traded for uniqueness.

### Limitations

- Marker identities are not collision-free. A retained literal that already ends in the same `#<path>` suffix, a uniqueness-constrained list (`required`, `enum`) that keeps such a literal, and sibling keys whose paths disagree with the literal spelling (`a.b` beside nested `a` → `b`) can render duplicate or ambiguous placeholders. Marker allocation and reconstruction validation are follow-up work; the current renderer does not reject a document it has made invalid.
- Covered identifier-list entries (for example `required`) print a location-unique placeholder rather than the original name: when marker identities do not collide, the document remains valid JSON Schema, but the identifiers are not preserved.
- `dependentRequired` has no dedicated handling; its covered values rely on the same marker-per-location rule.

### Changed

- A covered non-string scalar inside a rendered schema no longer prints as a marker string. A covered numeric constraint or enumerated `type` member is omitted, a covered boolean subschema becomes the neutral `{}` schema, and a covered string keyword value is omitted, so the emitted schema stays valid JSON Schema instead of turning `minLength: 7`, `flag: false` or `type: "…"` into a string no keyword accepts. A partially covered string still keeps its surrounding diagnostic text.
