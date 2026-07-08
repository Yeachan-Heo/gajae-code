**Tasks are referenced by their verbatim content string, not by any auto-generated ID. There is no "task-1"/"task-N" identifier — the tool never emits one. Pass the task's content text in the `task` field.**

Manages a phased task list. Pass `ops`: a flat array of operations.
The next pending task is auto-promoted to `in_progress` after each completion.
Allowed `op` values are only `init`, `start`, `done`, `drop`, `rm`, `append`, and `note`. `pending` is a task status, not an `op`; leave not-yet-started tasks implicit in `init`/`append` lists.

## Operations

|`op`|Required fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize the full list (replaces any existing list)|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`rm`|`task` or `phase` or *(none = clear all tasks)*|Remove a task; with `phase`, empties the phase (the phase entry remains); bare `rm` clears every task in every phase|
|`append`|`phase`, `items: string[]`|Append tasks to `phase`; lazily creates phase|
|`note`|`task`, `text`|Append a note to a task. Reminders for future-you only.|

## Anatomy
- **Task content**: 5–10 words, what is being done, not how. Used as the task identifier — unique.
- **Phase name**: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`). Used as the phase identifier — unique. Do not add prefixes like `1.`, `A)`, `Phase 1:`, etc.

## Rules
- Mark tasks done immediately after finishing.
- Complete phases in order.
- On blockers, `append` a new task to the active phase to unblock yourself, or `drop`.
- `task` and `phase` fields reference content/name verbatim; keep them stable once introduced.

## When to create a list
- Task requires 3+ distinct steps
- User explicitly requests one
- User provides a set of tasks to complete
- New instructions arrive mid-task — capture before proceeding

<examples>
# Initial setup (multi-phase)
`{"ops":[{"op":"init","list":[{"phase":"Foundation","items":["Scaffold crate","Wire workspace"]},{"phase":"Auth","items":["Port credential store","Wire OAuth providers"]},{"phase":"Verification","items":["Run cargo test"]}]}]}`
# Initial setup (single phase)
`{"ops":[{"op":"init","list":[{"phase":"Implementation","items":["Apply fix","Run tests"]}]}]}`
# Complete one task
`{"ops":[{"op":"done","task":"Wire workspace"}]}`
# Complete a whole phase
`{"ops":[{"op":"done","phase":"Auth"}]}`
# Remove all tasks
`{"ops":[{"op":"rm"}]}`
# Drop one task
`{"ops":[{"op":"drop","task":"Run cargo test"}]}`
# Append tasks to a phase
`{"ops":[{"op":"append","phase":"Auth","items":["Handle retries","Run tests"]}]}`
</examples>
