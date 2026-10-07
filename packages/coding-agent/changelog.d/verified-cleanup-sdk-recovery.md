### Fixed

- Revert the unvalidated #6388 task-owner/session-cleanup changes while retaining per-token SDK terminal publication, event ordering, and continuation ownership needed to settle accepted prompts. Durable task-artifact ownership remains deferred; established lifecycle, retirement, and artifact-owner paths stay unchanged.
