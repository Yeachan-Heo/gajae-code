# monitor

> Start a background monitor that streams stdout lines as task notifications. Mirrors Claude Code's `Monitor` tool surface.

## Source

- Entry: `packages/coding-agent/src/tools/monitor.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/monitor.md`
- Key collaborators:
  - `packages/coding-agent/src/async/job-manager.ts` — stores the captured stream via `appendOutput`/`readOutputSince` and delivers the final background-job result.
  - `packages/coding-agent/src/exec/bash-executor.ts` and `packages/coding-agent/src/session/streaming-output.ts` — provide the unthrottled `onRawChunk` capture hook that feeds the manager.
  - `packages/coding-agent/src/tools/bash.ts` — exposes `BashTool.startMonitorJob(...)`, a Bash-aligned helper that preserves interception, cwd/env expansion, artifacts, timeouts, and raw stream capture.
  - `packages/coding-agent/src/tools/job.ts` — polls/cancels the monitor task by id; there is no sibling `MonitorKill` tool.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `command` | `string` | Yes | Shell command to run as a background monitor. Each sanitized stdout line is captured; persistent notifications are coalesced before delivery. |
| `kind` | `"log" \| "poll" \| "watch" \| "other"` | Yes | Category of monitor. Surfaces in listings. |
| `description` | `string` | Yes | Short human-readable summary of what is being monitored. |
| `timeout` | `number` | No | Maximum wall-clock seconds the monitor may run before automatic shutdown, from 1 to 3600 (the Bash timeout ceiling). `execute(...)` rejects larger values with a `ToolError` before any job is created. Omit for session lifetime. |
| `persistent` | `boolean` | No | Keep the monitor running after its first emitted event. Persistent monitors survive until session end, timeout, or explicit cancel via `job`. Defaults to `false`. |

## Outputs

The tool returns one text block plus `details`:

- `content[0].text`: `Monitor started · task <task_id> · persistent: true|false`.
- `details`: `{ taskId, kind, description, command, persistent }`.

Each newline-terminated stdout line is appended to the manager-owned cursor. Persistent monitors debounce notification delivery and send the latest line with a count of coalesced earlier lines; ordinary log/poll traffic therefore does not create one model turn per event-loop tick. Use `job` with the returned `taskId` to inspect completion state or terminate the monitor.

## Behavior / Lifecycle

1. `MonitorTool.createIf(session)` gates the tool on `isBackgroundJobSupportEnabled(session.settings)` — identical to `JobTool`'s gate.
2. `execute(...)` first rejects an explicit `timeout` above the Bash ceiling (`TOOL_TIMEOUTS.bash.max`, 3600s), then delegates to `BashTool.startMonitorJob(...)`, so Monitor inherits Bash's interception rules, cwd normalization, internal URL expansion, environment construction, artifact allocation, and unthrottled raw capture. The schema keeps no `maximum` so it stays identical to the upstream parity fixture.
3. The helper mirrors every sanitized raw chunk to `manager.appendOutput(jobId, chunk)` and line-buffers the stream. Persistent notifications are latest-biased and coalesced over a short debounce window; terminal completion flushes the newest pending line.
4. Non-persistent monitors auto-cancel after delivering their first stdout-line notification. Persistent monitors terminate when the underlying command exits, `timeout` elapses, the calling agent is torn down, or the user cancels the returned background task via `job`. Cancellation and eviction purge pending persistent notifications rather than delivering stale output.

## Errors

- `ToolError`: `Async execution is disabled; the monitor tool is unavailable in this session.` — emitted when `AsyncJobManager.instance()` returns `undefined`.
- `ToolError`: `Monitor timeout <n>s exceeds the 3600s maximum. ...` — emitted for an explicit `timeout` above 3600 before any async job or notification is created. Monitor is not a delayed scheduler; use `cron` to run work later.
- Invalid parameter shapes are rejected by zod with the project's standard validation error path.

## Examples

Tail an error log and react when lines appear:

```jsonc
{
  "command": "tail -F /var/log/app.log | grep -i error",
  "kind": "log",
  "description": "Tail app.log for errors"
}
```

Poll CI status until the build completes (15-minute timeout):

```jsonc
{
  "command": "while true; do gh run view --json status,conclusion --jq .status; sleep 30; done",
  "kind": "poll",
  "description": "Watch CI build status",
  "timeout": 900,
  "persistent": false
}
```

## Parity oracle

The schema and behavior captured in this doc are pinned by the fixture at
`packages/coding-agent/test/fixtures/claude-code-tools/monitor.schema.json`,
captured from the upstream Claude Code CLI (`claude --version 2.1.152`). Any
deviation from that fixture is a parity bug.
