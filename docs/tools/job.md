# job

> Wait for or cancel background jobs managed by the session async runtime.

## Source
- Entry: `packages/coding-agent/src/tools/job.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/job.md`
- Key collaborators:
  - `packages/coding-agent/src/async/job-manager.ts` — job registry, cancellation, delivery suppression.
  - `packages/coding-agent/src/async/support.ts` — feature gating for background jobs.
  - `packages/coding-agent/src/tools/bash.ts` — explicit async bash and auto-backgrounded bash jobs.
  - `packages/coding-agent/src/task/index.ts` — async task-job scheduling.
  - `packages/coding-agent/src/sdk/session.ts` — automatic follow-up delivery for unsuppressed completions.
  - `packages/coding-agent/src/config/settings-schema.ts` — `async.pollWaitDuration` options.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `poll` | `string[]` | No | Job ids to watch. Cannot be combined with `list`. If omitted (and `cancel` is also omitted), the tool watches all running jobs. If provided, missing ids are silently filtered out before waiting. |
| `cancel` | `string[]` | No | Job ids to cancel before any polling. Missing ids are reported as `not_found`; non-running ids as `already_completed`. |
| `list` | `boolean` | No | Return an immediate snapshot of every job spawned by the calling agent (running + completed within retention) without waiting. Read-only — cannot be combined with `poll` or `cancel`. |

## Outputs
The tool returns one text block plus `details`.

- `content[0].text`: markdown-like plain text sections assembled by `#buildResult(...)`:
  - `## Cancelled (N)` for cancel outcomes.
  - `## Completed (N)` for non-running jobs, including stored `resultText` and `errorText`.
  - `## Still Running (N)` for jobs still in `running`.
- `details.jobs`: array of snapshots:
  - `id: string`
  - `type: "bash" | "task"`
  - `status: "running" | "completed" | "failed" | "cancelled"`
  - `label: string`
  - `durationMs: number`
  - optional `resultText`, `errorText`
- `details.cancelled` appears only when `cancel` was passed; each item is `{ id, status }` where status is `"cancelled" | "not_found" | "already_completed"`.

Streaming behavior:
- During a polling wait, `execute(...)` emits `onUpdate(...)` every 500 ms with an empty text block and fresh `details.jobs` snapshots.
- Final return is single-shot after a completion, timeout, abort, or immediate fast path.

Read-only snapshot path:
- Calling `job` with `list: true` returns a markdown summary of every job spawned by the calling agent (running + completed within retention) without waiting.

## Flow
1. `JobTool.createIf(...)` in `packages/coding-agent/src/tools/job.ts` only exposes the tool when `isBackgroundJobSupportEnabled(...)` returns true for either `async.enabled` or `bash.autoBackground.enabled`.
2. `execute(...)` fetches `session.asyncJobManager`. If absent, it returns `Async execution is disabled; no background jobs are available.`
3. `cancel` ids are processed first:
   - `manager.getJob(id)` missing → `not_found`.
   - existing job with `status !== "running"` → `already_completed`.
   - running job → `manager.cancel(id)`, which sets `job.status = "cancelled"`, aborts the controller, and schedules eviction.
4. Polling mode is chosen with `const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0`:
   - only `cancel` present → return immediately, no wait.
   - explicit `poll`, or no args at all → proceed to watch jobs.
5. Watch set resolution:
   - explicit `poll` → map ids through `manager.getJob(...)` and drop missing ones.
   - no `poll` and no `cancel` → `manager.getRunningJobs()`.
6. Empty watch set returns immediately:
   - if cancellations happened, return snapshots for the cancelled ids that still exist.
   - else return either `No matching jobs found for IDs: ...` or `No running background jobs to wait for.`
7. If every watched job is already non-running, `#buildResult(...)` returns immediately without waiting.
8. Otherwise the tool waits on `Promise.race(...)` across:
   - every watched running job's `job.promise`,
   - a timeout promise for `async.pollWaitDuration`,
   - the tool-call abort signal when present.
9. Before waiting, it calls `manager.watchJobs(watchedJobIds)`. This suppresses automatic completion delivery for those ids while they are being watched.
10. If `onUpdate` exists, a 500 ms interval sends progress snapshots from `#snapshotJobs(...)`; one snapshot is emitted immediately before entering the race.
11. In `finally`, the tool always calls `manager.unwatchJobs(...)`, clears the timeout, and stops the progress interval.
12. `#buildResult(...)` deduplicates jobs, snapshots current manager state, then calls `manager.acknowledgeDeliveries(...)` for every non-running job in the result. That suppresses later automatic follow-up delivery for the same completions and removes queued deliveries for those ids.
13. The final text groups jobs by non-running vs still-running state. A timeout is not an error path; it simply returns the current snapshot.

## Modes / Variants
- Poll all running jobs: call with neither `poll` nor `cancel`.
- Poll explicit ids: call with `poll` only.
- Cancel only: call with `cancel` only; cancellations happen and the tool returns immediately.
- Cancel then poll: call with both. Cancellations are applied first, then the tool watches the remaining resolved `poll` ids.
- Read-only inspection: call with `list: true` for the same snapshot data without waiting on completion.

Spawn paths that produce jobs:
- `packages/coding-agent/src/tools/bash.ts`
  - `async: true` always registers a `type: "bash"` job with `AsyncJobManager.register(...)` and returns a start message.
  - auto-background mode (`bash.autoBackground.enabled`) starts the same managed job path for non-PTY commands, waits up to `min(bash.autoBackground.thresholdMs, timeoutMs - 1000)`, and if the command is still running returns a background-job start result instead of inline command output.
- `packages/coding-agent/src/task/index.ts`
  - when `async.enabled` is on, the chosen agent is not blocking, and `tasks.length > 0`, each task item is registered as a `type: "task"` job.

Lifecycle and exact state names:
- Conceptual scheduling path: `pending` (only task-progress bookkeeping before work starts) → `running` → `completed` / `failed`; cancellation changes a running async job to `cancelled`.
- Exact `AsyncJob.status` values in `packages/coding-agent/src/async/job-manager.ts`: `"running" | "completed" | "failed" | "cancelled"`.
- Exact per-task progress values in `packages/coding-agent/src/task/types.ts`: `"pending" | "running" | "completed" | "failed" | "aborted"`.

## Side Effects
- Filesystem
  - None in `job.ts` itself.
  - Jobs being observed may already have written artifacts/results through their own tool runtimes.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Reads and mutates `session.asyncJobManager` state.
  - `watchJobs(...)` / `unwatchJobs(...)` toggle delivery suppression for the watched ids.
  - `acknowledgeDeliveries(...)` marks completed ids as suppressed and removes queued deliveries for them.
  - `cancel(...)` aborts running jobs through each job's `AbortController`.
- User-visible prompts / interactive UI
  - Polling emits periodic `onUpdate` snapshots every 500 ms.
  - Automatic job completion follow-ups are generated by `packages/coding-agent/src/sdk/session.ts` only for unsuppressed deliveries.
- Background work / cancellation
  - Waiting uses a timeout plus optional tool-call abort signal.
  - Cancelling a job does not synchronously await teardown; it flips state, aborts, and returns control to the manager/job promise.

## Limits & Caps
- Poll wait duration comes from `async.pollWaitDuration` in `packages/coding-agent/src/config/settings-schema.ts`:
  - allowed values: `5s`, `10s`, `30s`, `1m`, `5m`
  - default: `30s`
- Progress update cadence while polling: `PROGRESS_INTERVAL_MS = 500` in `packages/coding-agent/src/tools/job.ts`.
- Async job retention default: `DEFAULT_RETENTION_MS = 5 * 60 * 1000` in `packages/coding-agent/src/async/job-manager.ts`.
- Manager fallback max-running limit: `DEFAULT_MAX_RUNNING_JOBS = 15` in `packages/coding-agent/src/async/job-manager.ts`.
- Session wiring clamps `async.maxJobs` to `1..100` before constructing the manager in `packages/coding-agent/src/sdk/session.ts`; settings default is `100` in `packages/coding-agent/src/config/settings-schema.ts`.
- Async completion delivery retry backoff in `packages/coding-agent/src/async/job-manager.ts`:
  - base `500` ms
  - max `30_000` ms
  - jitter `< 200` ms
  - exponent capped at 8 doublings

## Errors
- Tool-disabled path is returned as normal text, not thrown: `Async execution is disabled; no background jobs are available.`
- Polling a nonexistent id is not an exception:
  - with `poll` only, missing ids are dropped; if none remain the tool returns `No matching jobs found for IDs: ...`.
  - with `cancel`, each missing id is reported as `not_found` in `details.cancelled` and text.
- Cancelling a non-running job is not an exception; it reports `already_completed` even if the actual status is `completed`, `failed`, or `cancelled`.
- Tool-call abort during polling stops waiting and returns a final snapshot through `#buildResult(...)`; it does not cancel watched jobs.
- Failures inside the underlying async work are stored on the job (`status: "failed"`, `errorText`) and reported in normal tool output, not rethrown by `job`.
- Calling `list: true` against an empty manager returns a normal empty-list result rather than throwing; missing ids passed to `poll` are silently filtered.

## Notes
- `job` waits for the first watched running job to settle, not for all watched jobs. If others remain `running`, they are reported under `## Still Running`; the caller must invoke `job` again to continue waiting.
- Delivery suppression is the key difference between snapshot and automatic delivery:
  - snapshots (`job` calls with `poll` or `list: true`) read current manager state;
  - follow-up delivery comes from `AsyncJobManager.#enqueueDelivery(...)` and `sdk.ts` `onJobComplete`;
  - watched or acknowledged ids are suppressed via `isDeliverySuppressed(...)`.
- `manager.cancel(id)` sets `status = "cancelled"` before the underlying promise settles. The job function may later populate `resultText` or `errorText`; `job-manager.ts` preserves that text but does not transition the status away from `cancelled`.
- Retention eviction removes the job record, suppression flags, and watch flag together. After eviction, both `job` calls and `list: true` snapshots behave as if the id never existed.
