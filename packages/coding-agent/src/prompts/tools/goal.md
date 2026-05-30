Manage the active goal-mode objective.

Use a single `op` field:
- `create` starts a goal. Requires `objective`. Use only when no goal exists and no goal is paused.
- `get` returns the current goal and usage state.
- `resume` re-activates a paused goal so work can continue.
- `complete` marks the goal complete after you have verified every deliverable against current evidence.
- `drop` discards the current goal without completing it.

Examples:
- `goal({"op":"create","objective":"Implement feature X"})`
- `goal({"op":"get"})`
- `goal({"op":"resume"})`
- `goal({"op":"complete"})`
- `goal({"op":"drop"})`

Call `complete` only when the goal is actually done and verified.
If `get` shows a paused goal, call `resume` before continuing work on it.
