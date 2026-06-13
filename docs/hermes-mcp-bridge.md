# Hermes MCP bridge

GJC exposes a native outward MCP bridge for Hermes-style coordinators:

```bash
gjc mcp-serve coordinator
```

`gjc mcp-serve hermes` is accepted as a compatibility alias for the same coordinator bridge.

The bridge is intentionally separate from GJC's client-side MCP runtime. It lets an external coordinator list sessions, start worktree/tmux-oriented sessions, queue bounded follow-up prompts, read status/tail/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Core contract and adapters

The coordinator bridge is intentionally a core contract with multiple adapters, not an MCP-only product direction. Hermes is one coordinator preset, not a product layer:

- `packages/coding-agent/src/coordinator/contract.ts` owns transport-neutral server metadata and tool names.
- `gjc mcp-serve coordinator` is the outward MCP adapter for Hermes-style agents.
- `gjc coordinator` is the read-only CLI/debug adapter for humans and scripts that need to inspect the same contract without starting MCP transport.
- `gjc setup hermes` is the setup adapter that renders coordinator config and operator guidance.

Future session, turn, question, artifact, and report behavior should move toward shared coordinator core services that both MCP and CLI adapters call instead of duplicating transport-specific logic.

## Standard Hermes setup

Use `gjc setup hermes` to render or install a portable Hermes MCP setup package:

```bash
gjc setup hermes --root /path/to/repo --profile my-bot --repo gajae-code
```

The default mode is render-only and writes no files. To install into a Hermes profile:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --profile my-bot \
  --repo gajae-code \
  --mutation sessions,questions,reports \
  --profile-dir /path/to/hermes/profile \
  --install
```

The generated setup is model-agnostic and worktree-isolated. By default it renders `GJC_COORDINATOR_MCP_SESSION_COMMAND` as `gjc --worktree`, so spawned sessions launch inside a GJC-managed sibling worktree while GJC still records the original repo as the project identity for tmux/session resume. Users who need a stable named branch can set `--worktree-name`; users who need a specific local wrapper, dev checkout, or provider/model can opt in explicitly:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --worktree-name hermes-gajae-code
```

```bash
gjc setup hermes \
  --root /path/to/repo \
  --session-command "gjc --worktree hermes-custom --model <provider/model>"
```

Provider/model examples are examples only; GJC does not hard-code GPT, Anthropic, or any other provider as the Hermes bridge default.

Run a non-mutating setup smoke check with:

```bash
gjc setup hermes --root /path/to/repo --smoke
```

Smoke verifies the MCP server/tool contract. It does not call a downstream LLM and does not validate provider credentials.


## Safety model

The bridge is read-only and fail-closed by default.

Required root allowlist:

```bash
export GJC_COORDINATOR_MCP_WORKDIR_ROOTS="/path/to/repo:/path/to/worktrees"
```

Mutating tools require both startup opt-in and per-call consent:

```bash
export GJC_COORDINATOR_MCP_MUTATIONS="sessions,questions,reports"
```

Every mutating MCP call must also include `allow_mutation: true`. Missing startup opt-in or missing per-call consent returns an error instead of falling back to shell or terminal relay.

Real tmux/GJC actuation uses the configured GJC-compatible session command. `gjc setup hermes` writes this as `gjc --worktree` by default so GJC owns worktree creation and resume identity:

```bash
export GJC_COORDINATOR_MCP_SESSION_COMMAND="gjc --worktree"
```

With that command configured, `gjc_coordinator_start_session` launches a detached tmux session, `gjc_coordinator_send_prompt` creates a durable turn and sends input to that pane, `gjc_coordinator_read_coordination_status` returns a canonical polling snapshot for sessions, session states, turns, questions, reports, and bounded event summaries, and `gjc_coordinator_read_tail` reads bounded advisory pane output. Tmux tail parsing is not the completion source of truth; turn completion comes from explicit durable turn state such as runtime session state or `gjc_coordinator_report_status`.

For resume safety, prefer the generated GJC-native worktree command over creating a git worktree in Hermes itself. GJC's launch path records the original repo as the project identity while running in the worktree, so session listing/resume can still group the session under the source project. If Hermes creates and later deletes an unmanaged worktree, a saved session may still exist but its cwd can be gone.

Artifact reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP`.

`gjc setup hermes` renders `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` with the host platform path delimiter (`:` on POSIX, `;` on Windows). Manual configs should prefer the same encoding.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export GJC_COORDINATOR_MCP_PROFILE="meeseeks2"
export GJC_COORDINATOR_MCP_REPO="gajae-code"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `gjc_coordinator_list_sessions`
- `gjc_coordinator_read_status`
- `gjc_coordinator_read_tail`
- `gjc_coordinator_list_questions`
- `gjc_coordinator_list_artifacts`
- `gjc_coordinator_read_artifact`
- `gjc_coordinator_read_coordination_status`
- `gjc_coordinator_read_turn`
- `gjc_coordinator_await_turn`
- `gjc_coordinator_watch_events`


Mutating tools:

- `gjc_coordinator_start_session`
- `gjc_coordinator_register_session`
- `gjc_coordinator_send_prompt`
- `gjc_coordinator_submit_question_answer`
- `gjc_coordinator_report_status`


`gjc_coordinator_register_session` registers an existing visible tmux-backed GJC pane as the coordinator-authoritative session. Use it when an operator has already launched a visible Warp/tmux lane and Hermes must send prompts to that same pane instead of creating a hidden `gjc-coordinator-*` session. The tool validates the workdir allowlist, safe session/target tokens, and tmux target liveness before writing session state.
## Turn orchestration flow

Hermes coordinators should treat turns, not terminal scrollback, as the unit of work:

1. Call `gjc_coordinator_start_session` with `allow_mutation: true`.
2. Call `gjc_coordinator_send_prompt` with `allow_mutation: true`.
3. Store the returned `turn_id`.
4. Poll `gjc_coordinator_read_turn`, or call bounded `gjc_coordinator_await_turn`, until the turn is terminal.
5. If `gjc_coordinator_list_questions` shows a question for that turn, answer with `gjc_coordinator_submit_question_answer`.
6. Use `gjc_coordinator_report_status` with `session_id` and `turn_id` to write explicit completion/failure evidence.

`gjc_coordinator_send_prompt` preserves the legacy `queued` and `delivered` fields and adds turn fields:

```json
{
  "ok": true,
  "session_id": "gjc-coordinator-demo",
  "turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "active_turn_id": "turn-00000000-0000-0000-0000-000000000000",
  "status": "active",
  "queued": false,
  "delivered": true
}
```

A session may have only one active turn by default. A second prompt is rejected with `active_turn_exists` unless the caller explicitly passes `queue: true` or `force: true`. Queued turns are durable and the next queued turn is promoted when the active turn reaches a terminal `gjc_coordinator_report_status`. Force supersedes the previous active turn and audits that state in the turn journal.

`gjc_coordinator_read_turn` returns the authoritative durable turn plus advisory pane status:

```json
{
  "ok": true,
  "turn": {
    "schema_version": 1,
    "turn_id": "turn-00000000-0000-0000-0000-000000000000",
    "session_id": "gjc-coordinator-demo",
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

The coordinator MCP bridge is currently a durable polling/await surface. It does not expose a push subscription stream; external coordinators should poll `gjc_coordinator_read_coordination_status`, `gjc_coordinator_read_turn`, or bounded `gjc_coordinator_await_turn` instead of waiting for server-sent push events.

External `session_id`, `turn_id`, and `question_id` values are validated before path use, and loaded records must match the requested session/turn owner.

## Coordinator event journal

The bridge persists a restart-safe event journal under the configured coordinator state namespace, for example:

```text
$GJC_COORDINATOR_MCP_STATE_ROOT/<profile>/<repo>/events/event-journal.jsonl
```

Each event is a bounded JSONL record with `schema_version`, monotonic namespace-local `seq`, stable `id`, `timestamp`, canonical `kind`, optional `session_id`/`turn_id`/`question_id`/`report_id`, short `summary`, optional `payload_ref`, and bounded scalar `metadata`. Full prompts, reports, final responses, and artifacts stay in their existing turn/report/artifact read paths; event records only point at them.

`gjc_coordinator_watch_events` is a bounded long-poll MCP tool, not an unbounded stream. Inputs are `after_seq` (default `0`), optional `session_id`, optional `event_types`, `timeout_ms` capped at 30000, and `limit` capped at 100. If matching events already exist after `after_seq`, it returns immediately. Otherwise it waits for the event journal to change or for timeout. The response includes `events`, `latest_seq`, `timed_out`, and `transport: { "mcp": "long_poll", "push_subscriptions": false }`, so coordinators can persist `latest_seq` and resume safely after restart.

`gjc_coordinator_read_coordination_status` keeps its existing report fields and now also includes `latest_event_seq` plus recent event summaries for snapshot-style consumers.
## Hermes config snippet

```json
{
  "mcp_servers": {
    "gjc_coordinator": {
      "command": "gjc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "GJC_COORDINATOR_MCP_WORKDIR_ROOTS": "/home/doyun/src/gajae-code",
        "GJC_COORDINATOR_MCP_PROFILE": "meeseeks2",
        "GJC_COORDINATOR_MCP_REPO": "gajae-code",
        "GJC_COORDINATOR_MCP_SESSION_COMMAND": "/home/doyun/.local/bin/gjc-dev-meeseeks2"
      },
      "enabled": true
    }
  }
}
```

## Smoke check

```bash
gjc mcp-serve coordinator --check --json
```

Expected result includes `ok: true`, server name `gjc-coordinator-mcp`, and the GJC-named tool list.
