Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`. Use only when no goal exists and no goal is paused.
- `get` returns the current goal and usage state.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.
- `pause` parks an active goal without completing or dropping it. While paused, the autonomous continuation loop stops re-activating the agent. Pause only when the goal is still alive but every outstanding deliverable is blocked on action only the user can perform (e.g. record, approve, a manual/physical step); it is never a substitute for `complete`. A paused goal keeps its progress and is resumable via `resume`.

Examples:
- `goal({"op":"create","objective":"Implement feature X"})`
- `goal({"op":"get"})`
- `goal({"op":"resume"})`
- `goal({"op":"pause"})`
- `goal({"op":"complete"})`
- `goal({"op":"drop"})`

If `get` shows a paused goal, call `resume` before continuing work on it.
