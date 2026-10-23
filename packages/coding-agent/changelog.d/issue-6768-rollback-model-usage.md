### Fixed

- Record a model in the recent-model (usage) order only after its selection succeeds: a model profile switch, TUI default model selection, or configuration reload that fails and rolls back (for example, to a CLI `--model` startup override) no longer records the failed pick or the restored model as a recent choice (follow-up to #6768).
