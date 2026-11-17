### Fixed

- Session dump text scrubs credential-shaped tokens before it is copied or printed.
- Session dump tool arguments keep the generated `<parameter>` markup out of the secret scrubber, so a masked value no longer swallows the closing tag.
- Session dump tool schema definitions keep property names, types, and constraints; only literal data under a credential-named property is masked.
- Credential-shaped tokens split across sibling tool-argument fields, including a credential-named field, are removed before that field is masked.
- An ordinary tool-argument array such as `["auth", "src"]` is no longer read as header name/value pairs.
