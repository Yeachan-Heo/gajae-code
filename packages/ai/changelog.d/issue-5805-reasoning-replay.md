### Fixed

- Cross-model assistant-history replay now collapses pathological runs of exact consecutive thinking paragraphs into one copy with the exact repeat count, preventing repeated reasoning from inflating custom OpenAI-compatible prompts while preserving stored history, final answers, tool content, and native same-model reasoning (#5805).
