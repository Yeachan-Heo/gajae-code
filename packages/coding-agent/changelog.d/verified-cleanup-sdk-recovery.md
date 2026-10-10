### Fixed

- Revert the terminal-publication rework introduced in #6388, which delayed SDK terminal settlement. Per-token SDK terminal publication, event ordering, and continuation ownership are now restored to settle accepted prompts promptly. Task-owner, lifecycle, retirement, and artifact-owner paths introduced in #6388 remain unchanged; their durable artifact-ownership work is deferred to a later release.
