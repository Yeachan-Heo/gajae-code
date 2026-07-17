Searches files using powerful regex matching.

<instruction>
- Supports Rust regex syntax (RE2-style — no lookaround or backreferences). Use line anchors or post-filters instead of (?!…)/(?<!…)
- `paths` accepts an array of files, directories, globs, or internal URLs; when omitted, the whole working directory is searched
- `paths` is an array; do not embed commas or spaces inside a single entry. Pass `["src", "tests"]` not `["src,tests"]`.
- Cross-line patterns are detected from literal `\n` or escaped `\\n` in `pattern`
</instruction>

<output>
{{#if IS_HL_MODE}}
- Text output is anchor-prefixed: `*5th|content` (match) or ` 9x}|content` (context, leading space). The 2-char suffix is a content fingerprint. The `|` before content is a separator, not part of the file content.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- Text output is line-number-prefixed
{{/if}}
{{/if}}
</output>

<critical>
- Search paths are an array; pass separate entries rather than comma-joined paths.
- Use a cross-line pattern only when the match actually spans lines.
</critical>
