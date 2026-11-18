### Changed

- Every built-in profile role that used `openai-codex/gpt-6.1-sol` now uses `openai-codex/gpt-6.2-sol` at the same effort. This covers `codex-medium`, `codex-pro`, `astra-lite`, `astra-default`, `astra-heavy`, `opus-codex`, `codex-opencodego`, and `fable-opus-codex`.
- Every built-in profile role that used `openai-codex/gpt-6-astra` now uses `openai-codex/gpt-6.2-astra` at the same effort. This covers `astra-lite`, `astra-default`, `astra-heavy`, `astra-fable`, and `astra-fable-opus`. Luna and non-Codex roles are unchanged.
- Codex web search now tries `gpt-6.2-sol` first, then `gpt-6.1-sol`, then `gpt-6-luna`. It still uses only models that the account's model discovery advertises.

### Added

- Added an autorouting strong/high label for `openai-codex/gpt-6.2-sol` at rank 3, after GPT-6 Sol and GPT-6.1 Sol.
