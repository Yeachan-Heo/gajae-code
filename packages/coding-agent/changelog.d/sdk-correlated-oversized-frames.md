### Fixed

- Keep SDK and ACP prompts alive when a streaming message snapshot exceeds the directed frame limit, and report a correlated delivery failure to the requester only when the undeliverable frame is the run's own terminal, so a prompt is never reported failed while its execution is still running.
- Preserve assistant text shape and terminal truncation metadata when bounding oversized correlated frames.
- Preserve as much aggregate assistant message_end text as fits, including ordered text blocks.
