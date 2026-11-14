### Fixed

- Choosing a model as the default in `/model` no longer fails with `Default model selection cannot inherit a thinking level` when the chosen model cannot keep the current thinking level (a non-reasoning model, or one whose levels exclude the current one). The selector reports `inherit` in that case; for the default role it now means "no explicit level", so the session uses the model's default level or keeps its current level when supported (otherwise off), and the persisted default selector carries no level.
