Start a background monitor that streams events from a long-running script. Each stdout line is captured; persistent notifications are latest-biased and coalesced over a short debounce window, while terminal completion flushes the newest pending line. Events arrive on their own schedule and are not replies from the user, even if one lands while you're waiting for the user to answer a question.

Pick by how many notifications you need:
- **One** ("tell me when the server is ready / the build finishes") → use `bash` with `async: true`. That returns a single completion notification when the command exits.
- **Many ongoing events** (logs, polling, file watching) → use `monitor`. The script keeps running and new stdout is captured; persistent notifications are coalesced so ordinary log traffic does not create one model turn per line.

`monitor` uses the same permission rules as `bash`. To stop a monitor, cancel its background task via `job` with the returned `task_id`, or end the session.

## When to reach for `monitor`

- Tail a log file and flag errors as they appear (`tail -F server.log | grep -i error`).
- Poll a PR or CI job and report when its status changes.
- Watch a directory for file changes (`fswatch -r dist/`).
- Track output from any long-running script you point it at.

`monitor` is not a scheduler. Do not use `sleep N; command` to run something later; use `cron` for delayed or recurring work.

## Inputs

- `command` (required): shell command to run as a background monitor. Stdout is captured line-by-line; persistent notifications are coalesced before delivery.
- `kind` (required): one of `"log"`, `"poll"`, `"watch"`, `"other"`. Describes the monitoring strategy so listings can surface useful categories.
- `description` (required): short human-readable description of what is being monitored. Appears in task listings.
- `timeout` (optional): maximum wall-clock seconds the monitor may run before automatic shutdown, from 1 to 3600. Larger values are rejected. Omit for the session lifetime.
- `persistent` (optional, default `false`): keep the monitor running past the current turn. Persistent monitors survive until session end or until cancelled via `job`.

## Output

Returns `Monitor started · task <task_id>` plus a task entry visible via `job({list: true})`. Persistent notifications contain the latest line and the count of earlier coalesced lines; terminal completion flushes the newest pending line.

## Cancellation

There is no separate `monitor` kill tool. Cancel a running monitor via `job({cancel: ["<task_id>"]})` using the returned `task_id`. Disposing the session also cancels every monitor the calling agent started.
