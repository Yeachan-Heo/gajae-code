### Performance

- Avoid unsupported Kitty placement extraction on ordinary non-Kitty input frames.
- Reuse unchanged editor logical-line layouts, including keyboard shrink/join paths that previously retained deleted-line cache entries.
- Reuse the byte/line admission decision for exact cached Markdown highlights instead of rescanning unchanged fenced code.
- Add a native-highlight input-to-synchronized-write benchmark with same-frame visibility checks. Scheduling, preparation, force precedence, and output revisions are unchanged.
