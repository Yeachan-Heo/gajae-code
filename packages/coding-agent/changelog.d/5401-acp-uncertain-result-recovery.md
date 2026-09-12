### Fixed

- ACP now makes one bounded, read-only `turn.result` lookup after an uncertain prompt or skill send, using an ACP-owned reference and exact terminal correlation to recover usable retained terminal evidence without replay. Missing, mismatched, nonterminal, or unavailable evidence remains `terminal_uncertain`; late acknowledgements cannot take ownership of a successor prompt. This recovers retained terminal evidence only: it does **not** settle aborted-tool resources or resolve all of #5401.
