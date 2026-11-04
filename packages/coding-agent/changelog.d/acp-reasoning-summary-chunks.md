### Fixed

- ACP clients now receive summarized reasoning as `agent_thought_chunk` updates. Anthropic summarized thinking and OpenAI Responses/Codex reasoning summaries stream as `reasoning_summary_delta`, which the ACP mapper dropped, so those models showed no thinking in ACP clients.
