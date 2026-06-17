Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`. Use only when no goal exists and no goal is paused.
- `get` returns the current goal and usage state.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.
- `pause` parks an active goal without completing or dropping it. The autonomous continuation loop stops while the goal is paused, so the agent is not re-activated every turn. Use `pause` (not `drop`) when the goal is genuinely still alive but every outstanding deliverable is blocked on human input or action only the user can perform — e.g. the user must sing, record, edit, approve, or perform a manual/physical step — and no further autonomous progress is possible. A paused goal keeps its progress and is fully resumable via `resume`.

Examples:
- `goal({"op":"create","objective":"Implement feature X"})`
- `goal({"op":"get"})`
- `goal({"op":"resume"})`
- `goal({"op":"pause"})`
- `goal({"op":"complete"})`
- `goal({"op":"drop"})`

Call `complete` only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
Do not `pause` as a substitute for `complete`; pause only when the outstanding work is human-blocked.
