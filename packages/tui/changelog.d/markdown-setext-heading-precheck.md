### Performance

- Streaming a long paragraph with no blank line (pasted logs, hard-wrapped output) slows the terminal much less as the paragraph grows. The setext-heading rule scanned the whole paragraph on every re-lex before it could fail; the paragraph is now checked for an underline line first, and the rule runs only when one is present.
