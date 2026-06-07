# Hermes MCP bridge

GJC exposes a native outward MCP bridge for Hermes-style coordinators:

```bash
gjc mcp-serve hermes
```

The bridge is intentionally separate from GJC's client-side MCP runtime. It lets an external coordinator list sessions, start worktree/tmux-oriented sessions, queue bounded follow-up prompts, read status/tail/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Safety model

The bridge is read-only and fail-closed by default.

Required root allowlist:

```bash
export GJC_HERMES_MCP_WORKDIR_ROOTS="/path/to/repo:/path/to/worktrees"
```

Mutating tools require both startup opt-in and per-call consent:

```bash
export GJC_HERMES_MCP_MUTATIONS="sessions,questions,reports"
```

Every mutating MCP call must also include `allow_mutation: true`. Missing startup opt-in or missing per-call consent returns an error instead of falling back to shell or terminal relay.

Real tmux/GJC actuation is enabled by setting a GJC-compatible session command:

```bash
export GJC_HERMES_MCP_SESSION_COMMAND="/path/to/gjc"
```

When set, `gjc_hermes_start_session` launches a detached tmux session, `gjc_hermes_send_prompt` creates a durable turn and sends input to that pane, and `gjc_hermes_read_tail` reads bounded advisory pane output. Tmux tail parsing is not the completion source of truth; turn completion comes from explicit durable turn state such as `gjc_hermes_report_status`.

Artifact reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `GJC_HERMES_MCP_ARTIFACT_BYTE_CAP`.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export GJC_HERMES_MCP_PROFILE="meeseeks2"
export GJC_HERMES_MCP_REPO="gajae-code"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `gjc_hermes_list_sessions`
- `gjc_hermes_read_status`
- `gjc_hermes_read_tail`
- `gjc_hermes_list_questions`
- `gjc_hermes_list_artifacts`
- `gjc_hermes_read_artifact`
- `gjc_hermes_read_coordination_status`
- `gjc_hermes_read_turn`
- `gjc_hermes_await_turn`

Mutating tools:

- `gjc_hermes_start_session`
- `gjc_hermes_send_prompt`
- `gjc_hermes_submit_question_answer`
- `gjc_hermes_report_status`

## Turn orchestration flow

Hermes coordinators should treat turns, not terminal scrollback, as the unit of work:

1. Call `gjc_hermes_start_session` with `allow_mutation: true`.
2. Call `gjc_hermes_send_prompt` with `allow_mutation: true`.
3. Store the returned `turn_id`.
4. Poll `gjc_hermes_read_turn`, or call bounded `gjc_hermes_await_turn`, until the turn is terminal.
5. If `gjc_hermes_list_questions` shows a question for that turn, answer with `gjc_hermes_submit_question_answer`.
6. Use `gjc_hermes_report_status` with `session_id` and `turn_id` to write explicit completion/failure evidence.

`gjc_hermes_send_prompt` preserves the legacy `queued` and `delivered` fields and adds turn fields:

```json
{
  "ok": true,
  "session_id": "gjc-hermes-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "active_turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "status": "active",
  "queued": false,
  "delivered": true
}
```

A session may have only one active turn by default. A second prompt is rejected with `active_turn_exists` unless the caller explicitly passes `queue: true` or `force: true`. Queued turns are durable but are not delivered immediately. Force supersedes the previous active turn and audits that state in the turn journal.

`gjc_hermes_read_turn` returns the authoritative durable turn plus advisory pane status:

```json
{
  "ok": true,
  "turn": {
    "schema_version": 1,
    "turn_id": "turn-00000000-0000-0000-0000-000000000000",
    "session_id": "gjc-hermes-demo",
    "status": "completed",
    "final_response": {
      "text": "Done",
      "format": "markdown",
      "source": "report_status",
      "artifact_path": null,
      "truncated": false
    },
    "evidence": [{ "path": "artifact.txt" }],
    "error": null
  },
  "advisory_status": {
    "live": true,
    "state": "idle_or_unknown"
  }
}
```

External `session_id`, `turn_id`, and `question_id` values are validated before path use, and loaded records must match the requested session/turn owner.
## Hermes config snippet

```json
{
  "mcp_servers": {
    "gjc_hermes": {
      "command": "gjc",
      "args": ["mcp-serve", "hermes"],
      "env": {
        "GJC_HERMES_MCP_WORKDIR_ROOTS": "/home/doyun/src/gajae-code",
        "GJC_HERMES_MCP_PROFILE": "meeseeks2",
        "GJC_HERMES_MCP_REPO": "gajae-code",
        "GJC_HERMES_MCP_SESSION_COMMAND": "/home/doyun/.local/bin/gjc-dev-meeseeks2"
      },
      "enabled": true
    }
  }
}
```

## Smoke check

```bash
gjc mcp-serve hermes --check --json
```

Expected result includes `ok: true`, server name `gjc-hermes-mcp`, and the GJC-named tool list.
