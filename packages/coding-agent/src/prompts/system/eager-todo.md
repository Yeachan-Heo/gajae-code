<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo_write` first in this turn.
Your call MUST use the top-level `ops` array with exactly one `init` operation.
The `init` operation MUST contain `list`, whose entries each have a unique `phase` and an `items` array of task strings.
Use this canonical shape:
```json
{"ops":[{"op":"init","list":[{"phase":"Investigation","items":["Locate relevant source and existing tests","Reproduce failure with focused contract test"]},{"phase":"Implementation","items":["Apply root cause fix across callsites"]},{"phase":"Verification","items":["Run focused tests and static checks"]}]}]}
```
You MUST cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task strings MUST be specific, unique labels of 5-10 words. A future turn MUST execute them without re-planning.
The tool automatically promotes the first task after initialization. Add extra context later with a separate `note` operation only when needed.

After `todo_write` succeeds, continue the request in the same turn.
Do not call `todo_write` again unless task state materially changed.
</system-reminder>
