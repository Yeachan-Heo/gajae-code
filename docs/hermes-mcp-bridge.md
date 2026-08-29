# Coordinator MCP bridge

GJC exposes a native outward MCP bridge for external coordinators:

```bash
gjc mcp-serve coordinator
```

`gjc mcp-serve hermes` is accepted as a compatibility alias for the same coordinator bridge.

The bridge is intentionally separate from GJC's client-side MCP runtime. It lets an external coordinator discover and control SDK-backed sessions, queue bounded follow-up prompts, read status/artifacts, handle structured questions, and write coordination reports without scraping terminal scrollback.

## Core contract and adapters

The coordinator bridge is intentionally a core contract with multiple adapters, not an MCP-only or Hermes-only product direction. Hermes is one compatibility preset, not a privileged integration mode:

- `packages/coding-agent/src/coordinator/contract.ts` owns transport-neutral server metadata and tool names.
- `gjc mcp-serve coordinator` is the outward MCP adapter for external agents.
- `gjc coordinator` is the read-only CLI/debug adapter for humans and scripts that need to inspect the same contract without starting MCP transport.
- `gjc setup hermes` is the compatibility setup adapter that renders coordinator config and operator guidance.

Future session, turn, question, artifact, and report behavior should move toward shared coordinator core services that both MCP and CLI adapters call instead of duplicating transport-specific logic.

## Coordinator setup adapter

Use `gjc setup hermes` to render or install a portable MCP setup package for any controller that accepts Hermes-compatible MCP config:

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

The generated setup is model-agnostic and worktree-isolated. By default it renders `GJC_COORDINATOR_MCP_SESSION_COMMAND` as `gjc --worktree`, which is a typed selector for SDK lifecycle creation—not a shell command the bridge runs. Spawned sessions launch inside a GJC-managed repo-local worktree while GJC retains the source repository as project identity. Users who need a stable named branch can set `--worktree-name`:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --worktree-name hermes-gajae-code
```

The runtime accepts only the literal selectors `gjc` and `gjc --worktree [name]`. It rejects local wrappers, shell syntax, tmux flags, and model/provider flags before creating a session. Existing setup configs that contain a legacy explicit `--session-command` must be changed to one of those selectors; provider and model resolution remains normal GJC configuration, not coordinator command injection.
### Custom or wrapper launch command

`--gjc-command` accepts the full command the controller execs (#4877). It is tokenized, never evaluated by a shell:

- Omitted, or a single token, names the executable only: `--gjc-command gjc` (the default) or `--gjc-command /opt/gjc` renders `command: gjc` / `command: /opt/gjc` with GJC-owned `args: [mcp-serve, coordinator]`.
- Multiple tokens are the full server command, split quote-aware (single/double quotes, backslash escapes) into controller argv and rendered verbatim with nothing appended: `--gjc-command "python3 /tmp/gjc-wrapper.py"` renders `command: python3`, `args: [/tmp/gjc-wrapper.py]`. A wrapper that already execs `gjc mcp-serve coordinator` — the historical workaround target — is emitted exactly as given, so it never receives a doubled argv tail. Spell the whole invocation to keep the tail: `--gjc-command "env WRAPPER=1 gjc mcp-serve coordinator"`.
- Unbalanced quotes are rejected with an explicit error.

```
mcp_servers:
  gjc_coordinator:
    command: python3
    args: [/tmp/gjc-wrapper.py]
```

## Agent directory override

`GJC_COORDINATOR_MCP_STATE_ROOT` selects coordinator durable state (session/turn/question journals, projections). It is **not** the broker selector: sessions started by the bridge use the GJC agent directory (`GJC_CODING_AGENT_DIR`; broker, lifecycle ledger, session index, `config.yml` / `models.yml`), and the spawned `gjc` process inherits it from the MCP server env. Pointing only `STATE_ROOT` at a separate directory leaves sessions on the default `~/.gjc/agent` broker.

Render the agent-directory override next to the state root with an absolute path:

```bash
gjc setup hermes \
  --root /path/to/repo \
  --state-root /var/lib/gjc/hermes-state \
  --coding-agent-dir /var/lib/gjc/hermes-agent
```

The rendered block then carries both keys as independent values:

```bash
export GJC_COORDINATOR_MCP_STATE_ROOT="/var/lib/gjc/hermes-state"
export GJC_CODING_AGENT_DIR="/var/lib/gjc/hermes-agent"
```

`--coding-agent-dir` requires an absolute path (Windows accepts `C:\...` and UNC `\\server\share\...`) and refuses the home directory, the account home, and the filesystem root, the same way `--root` does. On `--install` of a GJC-managed block, an existing `GJC_CODING_AGENT_DIR` is preserved unless `--coding-agent-dir` is passed, which overrides it explicitly; the value participates in the managed setup signature, so `--check` detects drift.

### MCP client timeouts (#4878)

The generated block writes `timeout: 180` and `connect_timeout: 60` (whole seconds). These are the host MCP client's per-call budgets — how long the controller waits for one `gjc_coordinator_*` tool call to return. They are **not** a GJC turn deadline, and not the coordinator per-call caps (`gjc_coordinator_watch_events` `timeout_ms` up to 30000 ms; `gjc_coordinator_await_turn` bounded at 30 minutes). Poll again instead of raising the client timeout.

Tune them explicitly:

```bash
gjc setup hermes --root /path/to/repo --timeout 900 --connect-timeout 30 --install
```

Both flags take whole seconds in the range 1–3600; anything else is rejected with exit code 2. Defaults stay 180/60 when the flags are omitted and no installed value exists.

`--install` preserves existing numeric `timeout` / `connect_timeout` values from a block carrying the GJC managed markers when the corresponding flag is omitted, per field: a hand-set `timeout: 900` survives the next install instead of being reset to 180. An explicit flag overrides the installed value. Render-only previews always show flag-or-default values, since there is no installed target to preserve from. The managed setup signature covers the GJC-owned plumbing (command, args, env) and deliberately does not pin these two knobs, so hand-tuning them keeps the block managed and `gjc setup hermes --check` does not report timeout drift.

Upgrading from a pre-#4878 install (whose signature included the timeout fields): a block whose stored content still matches its stored signature is still recognized as managed and is re-signed on the next `--install` (`--check` reports its signature as stale until then). A pre-#4878 block whose timeout was hand-tuned no longer matches either digest, so plain `--install` refuses with the stale-signature error pointing at `--force`; `--force` adopts the managed block and preserves the tuned values. `--force` never discards installed timeout values — pass `--timeout 180 --connect-timeout 60` to reset them explicitly.

`--profile-dir` installs also write the operator instructions file, whose digest pins its exact content. A release that changes that template (as this one does) therefore requires one `--force` for profiles holding an older render; the installed numeric timeout values are preserved across that upgrade too.

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

Every mutating MCP call that requires a caller key must include `allow_mutation: true` and the required caller-provided `idempotency_key`. The bridge durably binds the key to the tool and canonical arguments, serializes concurrent duplicates, replays the original bounded public response, and rejects reuse with different arguments as `idempotency_conflict`. `gjc_coordinator_report_status` also records a canonical report operation in the session ledger before terminal projection; after a process crash, retrying the identical key repairs the canonical projections and retained event delivery before reconstructing the committed report/turn response instead of creating a second report. A replay consults the durable receipt/canonical report before revalidating mutable evidence paths, so deleting or renaming an evidence file cannot invalidate an already committed retry.

`gjc_coordinator_start_session` uses SDK lifecycle control with the configured typed GJC selector. `gjc setup hermes` writes `gjc --worktree` by default:

```bash
export GJC_COORDINATOR_MCP_SESSION_COMMAND="gjc --worktree"
```

The only supported values are `gjc` and `gjc --worktree [name]`; this variable is never evaluated as a shell command.

The configured name is a default, not a per-task assignment. `gjc_coordinator_start_session`, `gjc_delegate_plan`, and `gjc_delegate_execute` accept a `worktree` argument that names this session's worktree and branch, which is what lets concurrent sessions in one repository get isolated checkouts. Omitting it falls back to the one worktree derived from the repository's current branch, and a second session that resolves to an occupied worktree is refused with `worktree_in_use` rather than silently sharing the checkout.

To make that isolation policy instead of caller discipline, set:

```bash
export GJC_COORDINATOR_MCP_REQUIRE_WORKTREE=true
```

A creation that did not name a worktree then fails with `worktree_required`. Session reuse through `session_id` creates no worktree and is unaffected. `gjc setup hermes --require-worktree` renders this alongside the worktree selector. The coordinator binds registration, reuse, and control to the broker's exact canonical workspace and endpoint generation, then discovers the generation-bound SDK endpoint internally. Endpoint credentials are never persisted in coordinator records or returned by coordinator tools. `gjc_coordinator_read_coordination_status` returns a canonical polling snapshot for public session, state, turn, question, report, and bounded event data. Tmux identifiers, when supplied while registering an existing session, are advisory process metadata only; they do not provide control authority, machine viewing, startup, prompt injection, or determine turn completion.

For resume safety, prefer the generated GJC-native worktree selector over creating a git worktree in Hermes itself. GJC's launch path records the original repo as the project identity while running in the worktree, so session listing/resume can still group the session under the source project. If Hermes creates and later deletes an unmanaged worktree, a saved session may still exist but its cwd can be gone.

Artifact reads are available only on Linux, where the bridge can enforce identity-bound handle authorization. On macOS and Windows, `gjc_coordinator_read_artifact` fails closed with the generic `artifact_unavailable` error; use `tools/list` to detect platform capability rather than branching on invocation errors; have the controller collect the bounded artifact through its own approved repository/worktree access and submit paths or summaries through coordinator reports instead. On Linux, reads are canonicalized, symlink escapes are rejected, and returned content is byte-capped by `GJC_COORDINATOR_MCP_ARTIFACT_BYTE_CAP`.

`gjc setup hermes` renders `GJC_COORDINATOR_MCP_WORKDIR_ROOTS` with the host platform path delimiter (`:` on POSIX, `;` on Windows). Manual configs should prefer the same encoding.

## Optional namespace

Use namespace variables to prevent cross-profile or cross-repo enumeration:

```bash
export GJC_COORDINATOR_MCP_PROFILE="team-a"
export GJC_COORDINATOR_MCP_REPO="gajae-code"
```

Missing namespace never widens into global session enumeration.

## Tool surface

Read tools:

- `gjc_coordinator_list_sessions` — enumerates GJC sessions the broker discovered under the allowed roots, which is a superset of the sessions this bridge can drive. Each entry reports `registered`; the other session-scoped tools resolve through the coordinator projection and refuse `registered: false` entries — `read_status`, `read_tail`, and `send_prompt` answer `not_found`, and `stop_session` reports `unknown_session`. Filter on it rather than discovering the difference through failed calls, and use `gjc_coordinator_register_session` to adopt one deliberately.
- `gjc_coordinator_read_status`
- `gjc_coordinator_read_tail`
- `gjc_coordinator_list_questions`
- `gjc_coordinator_list_artifacts`
- `gjc_coordinator_read_artifact`
- `gjc_coordinator_read_coordination_status`
- `gjc_coordinator_read_turn`
- `gjc_coordinator_await_turn`
- `gjc_coordinator_watch_events`
- `gjc_coordinator_read_codex_handoff` — reads the Codex app-server resume bridge registration and durable wake state; endpoints are unix sockets or loopback TCP only. Public handoffs report only whether a token is configured, never its path. Token files are independently authorized under `GJC_COORDINATOR_MCP_CODEX_TOKEN_ROOT` (default: the coordinator state root's managed `codex-tokens` directory), must be owner-only (`0600` or stricter), regular non-symlink files owned by the coordinator user, 1–4096 bytes, and contain neither CR nor LF. The coordinator binds the canonical no-follow file identity at registration and rejects replacement at delivery. Returned wake events expose lifecycle schema version 1 (`pending` → `requested`, `published` → `delivered`, `acked` → `acknowledged`, `failed` → `failed`); durable `attempts` and `last_error` are its failure/retry metadata. Heartbeats are unsupported (`automation_update_unavailable`), so delivery remains event-driven with startup drain.


Mutating tools:

- `gjc_coordinator_start_session`
- `gjc_coordinator_activate_session`
- `gjc_coordinator_stop_session` — closes and reaps coordinator delegate-created ephemeral sessions. A user-registered non-ephemeral session is refused unless the caller sets `force: true` and the bridge has the `GJC_COORDINATOR_MCP_FORCE_STOP` capability.
- `gjc_coordinator_register_session`
- `gjc_coordinator_send_prompt`
- `gjc_coordinator_submit_question_answer`
- `gjc_coordinator_report_status`
- `gjc_coordinator_register_codex_handoff` — registers the Codex app-server resume bridge with a unix/loopback endpoint and an independently authorized token-file reference only; raw token material and paths outside the configured token root are rejected.
- `gjc_coordinator_ack_codex_handoff` — acknowledges a Codex resume wake by durable `wake_key`; wake prompts never include GJC final responses.
- `gjc_delegate_plan`
- `gjc_delegate_execute`

The `gjc_delegate_*` tools are high-level, session-level delegation: each starts (or reuses) an SDK-discovered session and sends one workflow-tagged turn for `/skill:ralplan` or `/skill:ultragoal`, returning a durable `turn_id`, status, and artifact references. They use the same `sessions` mutation class and fail-closed workdir gating as `gjc_coordinator_start_session`, and emit a `delegation.started` event. Pass `await_completion: true` to use the durable bounded await/report path; `timeout_ms` and `poll_interval_ms` apply to that completion payload. Without it, the tool returns immediately after SDK acknowledgement. Pass `cwd` and `task`; set `allow_mutation: true` and a caller-provided `idempotency_key` only with startup mutation opt-in plus per-call consent. Optionally pass `mpreset` (same semantics as `gjc --mpreset <profile>`) to `gjc_coordinator_start_session` or a delegate tool to authoritatively activate a GJC model profile when starting a fresh session — it is resolved through the merged built-in/custom profile registry, applied from the first turn, and surfaced in status; unknown names are rejected with the available-profile listing, and reusing a session with a conflicting `mpreset` fails with `mpreset_conflict`. Pass `model` (`gjc --model <provider/model>` grammar, e.g. `cursor/claude-fable-5-xhigh`) instead of, or alongside, `mpreset` to pin one explicit model for the started session (#4707): it is resolved with the same CLI selector grammar, unknown ids are rejected before any session is created with the CLI's not-found error, and when both are given the explicit `model` wins exactly like `gjc --mpreset <p> --model <m>`. Prefer these over manual `start_session` + `send_prompt` when delegating a whole workflow.

`gjc_coordinator_register_session` re-registers an SDK-discoverable GJC session only when its matching coordinator record already establishes the sidecar authority used to authenticate runtime updates. A new running session cannot receive a newly minted private key; use `gjc_coordinator_start_session` to establish one. Optional tmux identifiers are retained only as advisory process metadata and are never machine-read.

`gjc_coordinator_activate_session` publishes the readiness a prepared session withheld. Start the session with `prepare_existing_thread: true` when an existing chat thread must be adopted: the session stays live and endpoint-addressable at state `prepared`, claims no root, refuses an initial prompt, and refuses `gjc_coordinator_send_prompt` with `session_not_activated`. Bind the thread with the daemon-owned `gjc notify bind-thread --session-id <id> --thread-ts <root>` command — the Coordinator never writes a chat mapping — then activate. Activation proves the exact endpoint generation, delegates the decision to the session's own activation gate (`not_bound` while no binding exists), is idempotent on replay, and moves durable state to `ready_for_input` only after the session proves `activated` or `already`.
## Turn orchestration flow

External coordinators should treat turns, not terminal scrollback, as the unit of work. The durable event journal is the watch-first lifecycle surface:

1. Call `gjc_coordinator_start_session` with `allow_mutation: true` and `idempotency_key`.
2. Call `gjc_coordinator_send_prompt` with `allow_mutation: true` and `idempotency_key`.
3. Persist the returned `session_id` and `turn_id`.
4. Call `gjc_coordinator_watch_events` with `after_seq` and persist **`next_after_seq` only**. A zero-time watch performs one bounded immediate reconcile/export pass; a positive timeout is a bounded long poll.
5. Handle metadata-only `turn.waiting_for_answer`, `question.opened`, `turn.completed`, and `turn.failed` events. Read details through `gjc_coordinator_read_turn` or `gjc_coordinator_list_questions`, then submit pending rows with `gjc_coordinator_submit_question_answer`.

`gjc_coordinator_report_status` is optional additive controller-authored evidence. Use it when the controller has an explicit summary/evidence record, needs to record policy cancellation (`status: "cancelled"`), or must provide a fallback failure report (`status: "failed"` plus `blocker`). Runtime-derived watch events do not require a preceding report.

`gjc_coordinator_send_prompt` returns versioned top-level routing fields that exactly mirror its nested durable `turn`: `status`, `queued`, and `delivered` equal `turn.status`, `turn.delivery.queued`, and `turn.delivery.delivered`; `active_turn_id` is the new turn id unless this response queued a follow-up, in which case it is the existing active turn id.

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

A session may have only one active turn by default. A second prompt is rejected with `active_turn_exists` unless the caller explicitly passes `queue: true` or `force: true`. Queued turns are durable and the next queued turn is promoted when the active turn reaches a terminal coordinator transition. Force supersedes the previous active turn and audits that state in the turn journal.
Coordinator cancellation is recorded through `gjc_coordinator_report_status` with terminal `status: "cancelled"`; this updates durable turn state but does not control any process. If the correct policy is replacement work rather than cancellation, send the replacement prompt with `force: true` so the previous active turn is superseded and audited.

`gjc_coordinator_read_turn` returns the authoritative durable turn and SDK-only advisory status. For the latest assistant output, use `gjc_coordinator_read_tail`; it queries `session.last_assistant` through the session SDK and returns only the requested bounded line suffix, never terminal output.

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
    "authority": "sdk",
    "live": true,
    "is_streaming": false
  }
}
```

The coordinator MCP bridge is a durable watch/poll/await surface. `gjc_coordinator_watch_events` is the preferred bounded lifecycle feed and does not expose a push subscription stream; external coordinators should persist its `next_after_seq` cursor and use `gjc_coordinator_read_turn` or `gjc_coordinator_list_questions` for details. `gjc_coordinator_read_coordination_status` and bounded `gjc_coordinator_await_turn` remain available for snapshot and compatibility consumers.

External `session_id`, `turn_id`, and `question_id` values are validated before path use, and loaded records must match the requested session/turn owner.

### Coordinator question pull loop

`gjc_coordinator_list_questions` requires `session_id` and reconciles the session's pending `workflow.gates.list` rows on every call. Its bounded response contains public `questions`, `diagnostics`, and `reconciliation`; `status: "pending"` selects pending rows, while `status: "open"` remains a compatibility alias. More than one pending question may be returned. Public rows expose only the safe question shape, public option ids, a versioned per-question `answer_schema`, and a fresh `answer_binding` for each pending row—never raw/private gate payloads or values. The schema describes the exact union: `{ "selected": ["opt_0"] }` (or multiple ids when `multi` is true), `{ "selected": [], "other": true, "custom": "..." }`, and `{ "action": "clarify", "question": "..." }`; an empty selected array is valid only when `allow_empty` is true.

`gjc_coordinator_submit_question_answer` requires `session_id`, `turn_id`, `question_id`, `answer_binding`, `answer`, `idempotency_key`, and `allow_mutation: true`. Copy the identifiers and binding from the pending row and validate against that row's versioned `answer_schema` (the generic tool schema is also discoverable through `tools/list`). The bridge re-reconciles and revalidates ownership, pending state, and the binding before calling `workflow.gate_answer`; it never invokes generic `ask.answer`. An incomplete snapshot fails as `terminal_uncertain`; stale, terminal, missing, or ownership-mismatched rows are non-answerable. Restart can remint or quarantine gates, so re-list instead of reusing old rows. Identical idempotent replay returns the original accepted result; the same key with different arguments fails `idempotency_conflict`. `custom` and clarification `question` strings must contain at least one non-whitespace character, at most 4096 Unicode code points (`maxLength`), and at most 4096 UTF-8 bytes (`x-maxUtf8Bytes`). Controllers must enforce both advertised bounds; this extension makes the multibyte byte limit explicit and matches runtime validation.

This pull-loop contract is independent of #2549/#2551 and unattended plain-CLI handling.

## Coordinator event journal

The bridge persists a restart-safe event journal under the configured coordinator state namespace:

```text
$GJC_COORDINATOR_MCP_STATE_ROOT/v1/<namespace-identity>/projections/events/event-journal.jsonl
```

`<namespace-identity>` is an opaque coordinator-owned projection identity; do not derive it from profile or repository names or consume this file as an integration API. Prefer `gjc_coordinator_watch_events` and persist its returned `next_after_seq` cursor.

Each event is a bounded JSONL record with `schema_version`, monotonic namespace-local `seq`, stable `id`, `timestamp`, canonical `kind`, optional `session_id`/`turn_id`/`question_id`/`report_id`, short `summary`, optional `payload_ref`, and bounded scalar `metadata`. Full prompts, reports, final responses, and artifacts stay in their existing turn/report/artifact read paths; event records only point at them.

`gjc_coordinator_watch_events` is a bounded long-poll MCP tool, not an unbounded stream. Inputs are `after_seq` (default `0`, a non-negative integer), optional `session_id`, optional `event_types`, `timeout_ms` capped at 30000, and `limit` capped at 100. If matching events already exist after `after_seq`, it returns immediately. Otherwise it waits for the event journal to change or for timeout. The response includes `events`, `latest_seq`, `next_after_seq`, `timed_out`, and `transport: { "mcp": "long_poll", "push_subscriptions": false }`. Persist **`next_after_seq` only** and send it as the next `after_seq`; `latest_seq` is only the snapshot watermark. This distinction matters for filtered or limited pages: `next_after_seq` may be lower than `latest_seq` until the page has been consumed. If a cursor is ahead of the snapshot, recover with the returned `snapshot_watermark` (typically restart from that watermark after deciding whether older events are still needed). Malformed cursors are rejected as `invalid_input`, not reported as coordinator unavailability.

`gjc_coordinator_read_coordination_status` keeps its existing report fields and now also includes `latest_event_seq` plus recent event summaries for snapshot-style consumers. Question data includes `question_snapshots` with per-session `diagnostics` and `reconciliation`; `summary.questions_complete` is false when any contributing snapshot is incomplete or unavailable, and `summary.questions`/`summary.open_questions` are then `null` rather than an authoritative zero. Controllers must retry question reconciliation before concluding that no input is required.

### Opt-in webhook delivery of journal rows

Issue #4706: the journal can additionally be pushed to one operator-configured webhook. This is delivery of **existing** rows only — no new event kinds, no MCP transport change (`push_subscriptions` stays `false`).

Configuration is env-only, default-off, and resolved through the **trusted credential environment** (inherited shell environment and GJC/user-owned env files) — the checkout's `.env` cannot supply these values, so a repository cannot choose where coordinator rows are POSTed. No MCP tool can set, read, or unset it:

| Variable | Effect |
|---|---|
|`GJC_COORDINATOR_MCP_EVENT_WEBHOOK_URL`|Destination. `https:` anywhere, or `http:` loopback only (`127.0.0.1`, `::1`, `localhost`). Unset or empty = feature fully off.|
|`GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TOKEN_FILE`|Absolute path to a file whose trimmed content is sent as `Authorization: Bearer …`. Raw tokens are never accepted inline.|
|`GJC_COORDINATOR_MCP_EVENT_WEBHOOK_SESSION_IDS`|Optional comma-separated allowlist; only rows carrying one of these `session_id` values are delivered.|
|`GJC_COORDINATOR_MCP_EVENT_WEBHOOK_TIMEOUT_MS`|Per-attempt request timeout, default 5000, capped at 30000.|
|`GJC_COORDINATOR_MCP_EVENT_WEBHOOK_MAX_ATTEMPTS`|Delivery attempts per row, default 5, capped at 10, with exponential backoff (500ms base, 15s cap).|

Delivery contract:

- The POST body is the exact native journal row already returned by `watch_events` (`schema_version`, `seq`, `id`, `timestamp`, `kind`, …). At-least-once: sinks dedupe on the stable `id`.
- Delivery runs off the journal append path through a durable per-row outbox (`webhook-outbox/` under the namespace), so a restart resumes pending rows and a dead sink never delays or rewrites terminal turn/session persistence. Retries and exhaustion are bounded; failures are logged to `event-webhook-errors.log` without failing turns.
- POSTs follow no redirects and send `content-type: application/json`.
- `gjc coordinator doctor` reports the resolved webhook state (enabled + destination, or unset) as an `event_webhook` check.

`watch_events` long-poll remains the source of truth; the webhook is a parallel opt-in sink for the same rows, targeted at orchestrators that cannot stay attached to the MCP session.

## Generic controller config snippet

```json
{
  "mcp_servers": {
    "gjc_coordinator": {
      "command": "gjc",
      "args": ["mcp-serve", "coordinator"],
      "env": {
        "GJC_COORDINATOR_MCP_WORKDIR_ROOTS": "/path/to/repo",
        "GJC_COORDINATOR_MCP_PROFILE": "team-a",
        "GJC_COORDINATOR_MCP_REPO": "project",
        "GJC_COORDINATOR_MCP_SESSION_COMMAND": "gjc --worktree"
      },
      "enabled": true
    }
  }
}
```

## Long-running delegated turns

A delegated prompt accepted through `gjc_delegate_execute` (which routes to `turn.prompt`) is governed by the same progress-aware SDK prompt deadline as any direct SDK prompt. The SDK accepts the prompt with `sdk.promptDeadlineMs` (`1_800_000` ms) as an inactivity lease and renews it only from attributable tool-execution progress (`tool_execution_start` / `tool_execution_end`) for the exact accepted `commandId`/`turnId`. Renewals are bounded by the hard maximum `sdk.promptMaxRuntimeMs` (`21_600_000` ms). Healthy long-running Ultragoal work therefore does not hit `prompt_deadline_exceeded` while it is still making attributable progress, yet a wedged or stuck turn still terminates deterministically.

Coordinator clients must persist the returned `session_id` and `turn_id`, observe lifecycle through `gjc_coordinator_watch_events` (`turn.waiting_for_answer`, `question.opened`, `turn.completed`, and `turn.failed`), and reconcile after disconnect/restart rather than blindly replaying the prompt. Read the authoritative turn or question details with the existing read tools; `gjc_coordinator_read_turn`, `gjc_coordinator_await_turn`, and Q26 `turn.result` reconciliation (`accepted` / `in_flight` / `terminal_ok` / `failed`) remain compatibility paths. The bounded `await_turn` poll timeout (`timeout_ms`) is distinct from the SDK prompt terminal deadline; await time-outs do not kill the turn.

## Smoke check

```bash
gjc mcp-serve coordinator --check --json
```

Expected result includes `ok: true`, server name `gjc-coordinator-mcp`, and the GJC-named tool list. The JSON check is discovery-only and non-mutating: it retains those legacy fields and adds `catalog: { "ready": true, "reason": null }` and `broker`. `broker.discovery_status` is `ready`, `unavailable`, or `error`, with reason `null`, `absent_or_invalid`, `unsupported_state_version`, `discovery_access_denied`, or `discovery_read_failed`. `broker.operational_ready` is always `null`; the check does not connect, ensure/bootstrap, write, repair, or delete. `bootstrap_supported` is `true` and `bootstrap_attempted` is `false`. It does not expose broker authority, path, endpoint, process metadata, token, or raw error details. `gjc mcp-serve hermes --check --json` returns the identical coordinator check payload; its human output remains the server/tools summary.
