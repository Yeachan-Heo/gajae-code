### Fixed

- A headless `ask` answered through a workflow gate now honors the tool abort signal and `GJC_ASK_ANSWER_DEADLINE_MS`, like the remote answer-source path. Before, the gate wait ignored both, so an aborted or expired ask left its gate pending. A failed gate ask now quarantines its gate, so a late answer cannot advance it.
