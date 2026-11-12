### Fixed

- ACP clients now receive the output of a turn they submit through `_gjc/sdk/control`, such as a `turn.abort_and_prompt` replacement of their own running prompt. Previously the replacement ran and was saved to the transcript, but the client saw only phase changes, because no `session/prompt` owned the turn. Output from turns the client did not submit, and from cancelled prompts, stays hidden (#7560).
