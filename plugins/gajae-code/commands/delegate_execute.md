---
name: execute
description: Delegate execution to GJC (runs /skill:ultragoal to completion with verification).
---

Call the `gjc_delegate_execute` coordinator MCP tool to delegate this work to gajae-code.

- Pass the current project directory as `cwd`.
- Pass the user's request as `task`.
- Only set `allow_mutation: true` after the user explicitly approves changes AND
  the coordinator server was started with the `sessions` mutation class enabled.
  Delegation is read-only until both conditions hold.

GJC starts a session and runs `/skill:ultragoal` to completion, returning a
durable `turn_id`, status, and artifact references. Poll with
`gjc_coordinator_await_turn` or `gjc_coordinator_watch_events`.
