### Fixed

- An SDK `ask.answer` now reaches a pending question while an earlier ordered control (for example `model.set` during a run) is still waiting for the turn to end. Before, the answer queued behind that control while the turn waited for the answer, so neither completed.
