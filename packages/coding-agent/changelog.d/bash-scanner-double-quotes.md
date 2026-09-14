### Fixed

- The bash mutation scanner no longer treats shell metacharacters in inert quoted values (`--evidence "p99 500ms -> 120ms"`, `"throughput > baseline"`) as redirections. Quoted mutator operands, quote-split command names, and live command substitutions remain subject to the planning mutation guard, including substitutions containing a quoted closing parenthesis. Quoted redirection operands remain visible to sink and bypass checks.
