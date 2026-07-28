<system-reminder>
Before substantive work, create a phased todo.

You MUST call `todo_write` first in this turn. Initialize the full request with this canonical payload shape:

```json
{"ops":[{"op":"init","list":[{"phase":"Investigation","items":["Inspect relevant implementation and tests"]},{"phase":"Implementation","items":["Implement the requested code change"]},{"phase":"Verification","items":["Verify requested behavior with tests"]}]}]}
```

Cover the entire request from investigation through implementation and verification — not just the next immediate step.
Task descriptions MUST be specific. A future turn MUST execute them without re-planning.
Task content MUST be a short label (5-10 words). The first task is automatically promoted to in progress; remaining tasks begin pending.

After `todo_write` succeeds, continue the request in the same turn.
Do not call `todo_write` again unless task state materially changed.
</system-reminder>
