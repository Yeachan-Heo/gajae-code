Schedule a prompt to fire on a recurring cron schedule, or one-shot at the next match. Cron tasks let you re-run a prompt automatically on an interval — poll a deployment, babysit a PR, check back on a long-running build, or remind yourself to do something later in the session.

Use a single `op` field to select the operation:

- `op: "create"` accepts a standard 5-field `cron_expression` in your local timezone, the `prompt` to run, and `recurring` (whether the job recurs or fires once). It returns an 8-character job id you can pass to `op: "delete"`. Each session can hold up to 50 scheduled tasks. Recurring tasks auto-expire 7 days after creation; one-shot tasks self-delete after firing.
- `op: "list"` enumerates every scheduled task in the session.
- `op: "delete"` cancels a task by `id`.

## Cron expressions

`op: "create"` accepts 5-field cron: `minute hour day-of-month month day-of-week`. All fields support `*`, single values (`5`), steps (`*/15`), ranges (`1-5`), and comma lists (`1,15,30`). Day-of-week uses `0`/`7` for Sunday through `6` for Saturday. Extended syntax like `L`, `W`, `?`, or month/weekday names is not supported.

| Example       | Meaning                      |
| :------------ | :--------------------------- |
| `*/5 * * * *` | Every 5 minutes              |
| `0 * * * *`   | Every hour on the hour       |
| `0 9 * * *`   | Every day at 9am local       |
| `0 9 * * 1-5` | Weekdays at 9am local        |

## Lifecycle

- Tasks fire between turns, never mid-response.
- All times are interpreted in the local timezone.
- Recurring tasks fire with up to 30 minutes of deterministic jitter (or up to half their interval for sub-hourly tasks). One-shot tasks scheduled for `:00` or `:30` may fire up to 90 s early. Pick an off-minute if exact timing matters.
- Closing or replacing the session clears every scheduled task.
