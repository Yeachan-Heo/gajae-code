### Added

- Bundled GPT-6.2 Astra (`gpt-6.2-astra`) and GPT-6.2 Sol (`gpt-6.2-sol`), released 2026-11-17, on `openai`, `openai-codex`, `opencode-zen`, `openrouter` (including `-pro` and `:batch` variants), `kilo` (including `-pro` and `-fast`), `vercel-ai-gateway` (including `-fast`), and `venice` (`openai-gpt-62-astra`, `openai-gpt-62-sol`, and their `-pro` variants). Both have a 1.05M context window, 128K max output, text and image input, and `low` through `max` reasoning effort.
- GPT-6.2 Astra pricing: $8 input / $40 output / $0.40 cached input / $10 cache write per 1M tokens; above 272K input tokens, $16 / $60 / $0.80 / $20.
- GPT-6.2 Sol pricing: $2 input / $10 output / $0.10 cached input / $2.50 cache write per 1M tokens; above 272K input tokens, $4 / $15 / $0.20 / $5.
- GPT-6.2 Astra and Sol accept the ultrafast service tier on `openai`, `openai-codex`, and `opencode-zen`.

### Changed

- GPT-6.2 Astra replaces GPT-6 Astra as the first OpenAI Codex model in the model selector. GPT-6 Astra stays in the catalog and can still be selected.
