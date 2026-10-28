### Fixed

- Kiro (OAuth and `ksk_` API key) now requests native reasoning through `additionalModelRequestFields` instead of a prompt-tag imitation:
  - Claude Opus/Sonnet 4.6+ and 5.x, plus Kimi K3, get adaptive thinking with `output_config.effort`.
  - GPT 5.6 gets `reasoning.effort`, and an explicit off sends `effort: "none"`.
  - Other models keep the prompt fallback (#7405).
- Kiro streams now parse `reasoningContentEvent` into thinking blocks and replay the returned `signature` or `redactedContent` on later assistant turns (#7405).
