# GJC Hermes operator instructions v{{TEMPLATE_VERSION}}

Server key: {{SERVER_KEY}}

These instructions teach a Hermes-style coordinator how to operate GJC through the `{{TOOL_PREFIX}}_*` MCP tools. They are setup guidance, not a GJC workflow skill.

## Core loop

1. Use `{{TOOL_PREFIX}}_list_sessions` to find an existing session, or `{{TOOL_PREFIX}}_start_session` when a new session is required and mutation is enabled.
2. Send exactly one bounded task prompt with `{{TOOL_PREFIX}}_send_prompt`.
3. Store the returned `turn_id`.
4. Prefer `{{TOOL_PREFIX}}_watch_events` with the stored `latest_seq` for event-driven progress; fall back to `{{TOOL_PREFIX}}_read_turn` or `{{TOOL_PREFIX}}_await_turn` for a specific `turn_id` until terminal.
   If a second task is needed while one turn is active, pass `queue: true`; the next queued turn is promoted after the active turn is reported terminal.
5. If GJC asks a structured question, use `{{TOOL_PREFIX}}_list_questions` and answer with `{{TOOL_PREFIX}}_submit_question_answer`.
6. Use `{{TOOL_PREFIX}}_report_status` for coordinator-visible status and final reports.
7. Use `{{TOOL_PREFIX}}_read_tail` only as advisory debug output when structured turn state is insufficient.

## Event watch

`{{TOOL_PREFIX}}_watch_events` is a bounded long-poll read tool. Call it with `after_seq` set to the last stored sequence number, optional `session_id` or `event_types`, `timeout_ms` up to 30000, and `limit` up to 100. Store the returned `latest_seq` before the next wait. A timeout with no events is not failure; call again or use the turn/status read tools for a snapshot.

Do not report completion to the user until the GJC turn is terminal. Do not infer completion from terminal scrollback alone.

Coordinator MCP is a durable polling/await bridge, not a push subscription stream. Use `{{TOOL_PREFIX}}_read_coordination_status`, `{{TOOL_PREFIX}}_read_turn`, and bounded `{{TOOL_PREFIX}}_await_turn` as the authoritative consumption surface.

## Worktree, model, and provider policy

The Hermes bridge does not choose a model/provider. Generated setup configures `GJC_COORDINATOR_MCP_SESSION_COMMAND` to `gjc --worktree` by default, so GJC creates and tracks the worktree while still using normal local model/provider resolution. Keep worktree creation inside GJC rather than creating unmanaged Hermes-side git worktrees; this preserves the original project identity for session listing and resume. If the operator config supplies a different `GJC_COORDINATOR_MCP_SESSION_COMMAND`, preserve it as explicit user intent.

Provider-specific commands are examples only, never product defaults.

## Safety

- Mutating tools require bridge startup mutation classes and per-call consent.
- Allowed roots restrict workdir and artifact paths.
- Artifact reads are bounded and should be treated as evidence, not unlimited filesystem access.
