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

### Changed

- A masked number or boolean inside a rendered schema prints as the marker string. The schema stays a readable record of the tool declaration, but it is not re-parseable as an equivalent schema: keeping the covered value's type would mean printing the covered value.
