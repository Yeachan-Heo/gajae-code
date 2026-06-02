# cron (CronCreate, CronList, CronDelete)

> Three sibling inline tools that mirror Claude Code's `CronCreate`, `CronList`, and `CronDelete` surface. Schedule recurring or one-shot prompts within the current session.

## Source

- Entry: `packages/coding-agent/src/tools/cron.ts`
- Model-facing prompt (shared by all three tools): `packages/coding-agent/src/prompts/tools/cron.md`
- Key collaborators:
  - `packages/coding-agent/src/async/job-manager.ts` — provides the `registerOwnerCleanup` / `runOwnerCleanups` primitives that clear schedules on session/agent teardown.
  - `packages/coding-agent/src/session/agent-session.ts` — invokes `runOwnerCleanups({ ownerId })` from `#cancelOwnAsyncJobs()` before cancelling owned jobs, so cron timers cannot race teardown.

## Tools

| Name | Purpose |
| --- | --- |
| `CronCreate` | Schedule a prompt on a 5-field cron expression. Returns an 8-character job id. |
| `CronList` | List every scheduled task in this session (per calling agent). |
| `CronDelete` | Cancel a scheduled task by id. |

Each session can hold up to **50** scheduled tasks per owner. Recurring tasks
auto-expire **7 days** after creation. One-shot tasks delete themselves after
firing.

## Inputs — CronCreate

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `cron_expression` | `string` | Yes | Standard 5-field cron expression in local time: `minute hour day-of-month month day-of-week`. |
| `prompt` | `string` | Yes | Prompt to inject between turns when the cron fires. |
| `recurring` | `boolean` | Yes | `true` to fire on every match (recurring, auto-expires after 7 days); `false` to fire once and self-delete. |

Supported field syntax: `*`, single values (`5`), steps (`*/15`), ranges
(`1-5`), comma lists (`1,15,30`). Day-of-week uses `0`/`7` for Sunday through
`6` for Saturday. Extended syntax such as `L`, `W`, `?`, or weekday/month
name aliases is **not** supported and the tool will reject expressions that use
them.

## Inputs — CronList

No parameters.

## Inputs — CronDelete

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | `string` | Yes | The 8-character job ID returned by `CronCreate`. |

## Outputs

- `CronCreate.content`: `Scheduled <id> (<human-schedule>)`. `details`: `{ id, cron_expression, recurring, nextFireAt }`.
- `CronList.content`: lines of `<id> (<human-schedule>): <prompt preview>`, or `No scheduled jobs` when empty. `details.jobs`: array of `{ id, cron, recurring, prompt, humanSchedule }`.
- `CronDelete.content`: `Cancelled <id>` on success, `Failed to remove scheduled task '<id>'` otherwise. `details`: `{ id, deleted }`.

## Behavior / Lifecycle

1. Each cron tool gates on `isBackgroundJobSupportEnabled(session.settings)`. When async is disabled, none of the cron tools are registered in `BUILTIN_TOOLS`.
2. Schedules are stored in-memory per `ownerId` (resolved via `session.getAgentId()`). Subagents have their own isolated schedule lists.
3. The first `CronCreate` call for a new owner registers an owner cleanup with `AsyncJobManager.registerOwnerCleanup(ownerId, fn)`. The cleanup clears every schedule for that owner and is run by:
   - `AgentSession.#cancelOwnAsyncJobs()` on dispose / new-session / session-switch / handoff / branch
   - `AsyncJobManager.dispose()` as a run-and-clear safety net
4. Cron expression validation rejects malformed input synchronously with a `ToolError` whose message names the offending field.
5. Each task is backed by a `setTimeout` for the next jitter-adjusted match. One-shot tasks self-delete after firing; recurring tasks reschedule until the 7-day expiry timer deletes them.
6. The per-owner 50-task cap is enforced on `CronCreate`; the caller receives a `ToolError` rather than a silent drop.

## Errors

- `ToolError`: `Async execution is disabled; cron is unavailable in this session.`
- `ToolError`: `Invalid cron expression: ...` (field count, range, step value, ordering)
- `ToolError`: `Cron task limit reached (50). Cancel an existing task with CronDelete first.`
- `ToolError`: `Cron is disabled by CLAUDE_CODE_DISABLE_CRON=1.`
- zod validation errors for missing or wrong-typed inputs.

## Examples

Schedule a 5-minute deployment poll:

```jsonc
// CronCreate
{
  "cron_expression": "*/5 * * * *",
  "prompt": "Check whether the staging deployment finished and tell me what happened",
  "recurring": true
}
```

One-shot reminder at 9am local:

```jsonc
// CronCreate
{
  "cron_expression": "0 9 * * *",
  "prompt": "Remind me to push the release branch",
  "recurring": false
}
```

Cancel a scheduled task:

```jsonc
// CronDelete
{ "id": "ab12cd34" }
```

## Parity oracle

Each tool's schema is pinned by a frozen fixture under
`packages/coding-agent/test/fixtures/claude-code-tools/`:

- `cron-create.schema.json`
- `cron-list.schema.json`
- `cron-delete.schema.json`

Fixtures were captured from the upstream Claude Code CLI (`claude --version 2.1.152`).
Any divergence between the fixture and the tool surface is a parity bug.
