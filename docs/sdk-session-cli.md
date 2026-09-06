# SDK session CLI

`gjc sdk session` is the broker-bound command family for operating live GJC SDK
sessions from the terminal. It replaces the removed `gjc daemon session` route.

The command family has six semantic verbs — `list`, `inspect`,
`send`, `status`, `tail`, and `retire` — plus the explicit `raw` hatch that dispatches one
SDK operation as `control`, `query`, or `global`.

The session CLI is advisory tooling over the SDK: every semantic verb resolves
sessions through the SDK broker, and output is rendered through a versioned,
credential-free DTO. Endpoint credentials are never printed.

## Broker authority

`list`, `inspect`, `send`, `status`, and `tail` resolve sessions through the
SDK broker and Router. The Router validates indexed endpoint authority and keeps
the connection credential in SDK core; the CLI receives only credential-free
results. The broker is started on demand (`ensureBroker`) when discovery is
absent, and an unavailable broker fails closed with a typed operational error
(exit 1).

`--agent-dir` selects the broker state directory; `--repo` selects the
workspace directory used for saved-session resolution (default: the current
directory).

## Semantic verbs

### list

`gjc sdk session list` queries the broker `session.list` global and projects
every indexed session into the versioned row DTO (`SESSION_ROWS_VERSION`). Each
row is credential-free and carries:

The list is fully paginated before scope filtering. By default its effective
scope is `repo`. Select a scope with:

```sh
gjc sdk session list --scope repo|cwd|worktree|all [--repo <path>]
```

`--repo` is the selected workspace path and defaults to the process cwd. The
result reports the effective `scope` and a bounded credential-free `selection`
descriptor containing the canonical selected path and, for Git selections,
the canonical worktree root and Git common directory.

- `repo` matches the canonical Git common directory, so the main checkout and
  linked worktrees are included while another repository is excluded.
- `worktree` matches only the selected path's canonical containing worktree.
- `cwd` matches only the exact canonical selected workspace; nested directories
  do not match.
- `all` preserves the complete unfiltered Broker listing.

For a path outside Git, `repo` and `worktree` fail with the typed
`not_a_repository` operational error and an actionable suggestion to use
`cwd` or `all`; they never broaden the result. `cwd` remains available for an
exact canonical path match. Unreadable or removed row workspaces are excluded
from Git scopes deterministically and reported in `warnings`.

`warnings` is bounded: at most 10 total warning entries are emitted per call,
including individual samples and source summary lines. A summary is emitted only
when that source had omitted entries and carries its exact omitted count and total.
This applies to both halves of the array — broker traversal warnings and
scope-exclusion warnings — so neither can grow with the size of the index.
Without the bound the array grew with the number of sessions on the machine
rather than with the result. The response now uses a bounded warning sample and
exact-count summaries.
`--scope all` performs no filtering and therefore emits no exclusion warnings.

The raw global `session.list` route remains unfiltered, and `inspect`, `send`,
`status`, `tail`, `retire`, and raw control/query behavior is unchanged.

- `sessionId` and the `locator` (`cwd`, `worktreeRoot`, `stateRoot`), where `cwd`
  is the canonical workspace directory and `worktreeRoot` is the canonical Git
  worktree root or `null` outside a worktree;
- `endpointGeneration`, `pid`, `live`, `deleted` (tombstone), `indexSeq`;
- `hostIncarnation` and `identityProvenance` (`composite` | `legacy`);
- `activity` (`{state: active|idle, at}`) and `lastHeartbeatAt`;
- `terminalUncertain`, `lifecycleRequestId`, `endpointMtimeMs`;
- `ambiguous` when the same `sessionId` has more than one unresolved
  authority-fencing `stateRoot` (cross-repo duplicate). A proven non-endpoint
  bookkeeping registration (the direct-session GC fence row, endpoint
  generation 0) stays indexed without fencing endpoint attachment; every other
  unresolved root, including an unproven generation-0 `lifecycle_terminal`
  claim, still fences.

### inspect

`gjc sdk session inspect <sessionId>` renders one indexed row from the broker.
It never reads endpoint discovery records directly: a missing or unavailable
broker fails closed rather than exposing endpoint authority outside SDK core.

### send

`gjc sdk session send <sessionId> --text <prompt>` submits an ordered
`turn.prompt` carrying a caller-chosen operation reference (a ULID by default,
or `--op-ref`). The result envelope reports `accepted` with the receipt and the
operation reference used for later reconciliation.

- `--wait` polls `turn.result` with `kind: "prompt"` until the prompt reaches a
  terminal state or the wait window (`--timeout-ms`, default 30s) elapses.
  `send --wait` never cancels a running turn; a window that elapses before a
  terminal state is reported as `wait_timeout` with the last observed status.

- `--text` and the JSON input sources (`--json-input`,
  `--json-input-file` — which must be a `0600` regular file —
  `--json-input-stdin`) are mutually exclusive for the prompt body.

### status

`gjc sdk session status <sessionId> <opRef>` performs a lossless `turn.result`
lookup with `kind: "prompt"` for a previously submitted operation reference and
returns the full reconciliation record plus a `summary.completed` flag.
See [lossless prompt results](#lossless-prompt-results).


### tail

`gjc sdk session tail <sessionId>` replays the retained transcript from the
durable checkpoint and then follows the live event-ring frames, emitting the
default tail kinds (session lifecycle and turn lifecycle events) plus retained
transcript entries.

- `--strict` fails closed with `retention_gap` (exit 1) when retained history
  or the event ring dropped entries before the checkpoint.
- `--until-idle` exits once the current turn reaches a terminal state; a session
  close exits any tail as `terminal: true`, while a bare live tail otherwise
  remains attached until `--timeout-ms`. Each item carries `revision` (the durable checkpoint revision); the triple `(revision,generation,seq)` is unique for the session, while `generation:seq` alone is revision-local and restarts each accepted prompt — key idempotency on the triple. Lifecycle
  events that carry a `(generation, seq)` position are reconciled and emitted in
  that canonical order rather than arrival order, so a retained terminal event
  from an earlier turn does not complete a newer turn that is still running, and
  a terminal event observed live is not undone by replayed history that arrives
  after it. Positioned event items are emitted canonically ahead of an
  arrival-ordered segment of events that carry no position; such an event stays
  visible but cannot supersede a positioned turn state. Different lifecycle
  kinds claiming the same `(generation, seq)` fail closed with `protocol_error`
  (exit 1) because no order between them can be proven, and that conflict
  outranks an otherwise successful idle or close completion. A canonical
  position is a pair of non-negative safe integers. A replayed event-ring row that
  states either coordinate property must state both validly; a row claiming only
  one coordinate, or a null, negative, fractional, non-finite, or
  unsafe-integer coordinate, fails closed with `protocol_error` rather than
  being treated as unpositioned. Only a row that states neither coordinate is
  unpositioned. Retained transcript entries are deduplicated independently of
  event-ring rows and are not event-ring authority, so a transcript row that
  projects the same kind and position as a real event never suppresses it. For a
  specific prompt operation, `status <sessionId> <opRef>` remains the lossless
  authority.
- `--all-events` widens the emitted set to every event-ring kind.
- `--cursor` resumes from a saved signed checkpoint claim. `session.checkpoint`
  verifies the unexpired claim and exchanges it for a fresh connection-owned
  cursor pinned to the exact prior revision; direct cross-connection cursor
  consumption remains rejected, so reconnect never echoes or rewinds a cursor.
- `--timeout-ms` bounds live follow; a session whose lifecycle already ended
  (terminal or `terminalUncertain`) replays retained history and exits instead
  of hanging.

A deleted session has no tail (`session_deleted`). A stopped session replays
its retained transcript without an endpoint (offline source), bounded to the
most recent retained entries.

### retire

`gjc sdk session retire <sessionId>` is the official semantic wrapper for the
`session.reconcile_uncertain` broker global. It retires an indexed
`terminalUncertain` create effect only when exactly one matching uncertain
create identity exists, the recorded host is proven exited, the endpoint is
absent, and any lifecycle marker/readiness leftovers are regular files bound to
that same PID and incarnation. The broker removes only those verified
leftovers, appends terminal `session_closed` evidence, and converts the
matching lifecycle receipt to a terminal error. Ambiguous identity, live or
unverifiable hosts, endpoint presence, malformed leftovers, and mismatches
refuse without signalling a process. Supply `--idempotency-key`; the JSON
input is read from a `0600` file or stdin when it contains proof material.

## Raw hatch

`gjc sdk session raw <control|query|global>` dispatches exactly one SDK
operation and returns the broker/host response:

- `raw control <sessionId> --op <operation>` — one control operation with
  `--json-input*`; `--confirm` confirms destructive control operations.
- `raw query <sessionId> --query <operation>` — one query; `--cursor` passes a
  continuation cursor.
- `raw global --op <operation>` — one broker global. Lifecycle globals
  (`session.create`, `session.fork`, `session.resume`, `session.close`,
  `session.delete`, `session.reconcile_uncertain`) require `--idempotency-key`.

A separately connected local controller can stop the active turn and its exact
owned work with an explicitly confirmed operator abort:

```sh
gjc sdk session raw control <sessionId> \
  --op turn.abort \
  --json-input '{"mode":"terminal","scope":"owned","operator":true}' \
  --idempotency-key '<unique-key>' \
  --confirm
```

The JSON input accepts only operation fields (`mode`, `scope`, `operator`).
`--confirm` and `--idempotency-key` are CLI authority inputs, not JSON fields.
The exact `operator:true` shape is routed through the local Broker, which
revalidates the current endpoint identity and injects a process-bound private
capability before dispatch. MCP, ACP, notifications, and ordinary SDK endpoint
requests cannot mint operator authority: copying `operator:true` and
`confirm:true` into a public control frame is rejected. Omitting confirmation,
omitting the key, or supplying `operator:false` fails closed without invoking
the terminal-abort surface. Non-operator terminal abort retains its existing
connection-ownership semantics.

`session.get_endpoint` is refused unconditionally: endpoint credentials remain
an SDK-core implementation detail. The raw hatch validates operation names and
adapter dispositions up front and never renders endpoint-disclosure results.

## Lossless prompt results

`turn.result` with `kind: "prompt"` reports `accepted`, `in_flight`,
`terminal_ok`, or `failed`; only retained-record capacity eviction yields
`unknown`. `turn.prompt_status` remains a legacy prompt-only alias. A prompt
that is active at process restart is finalized from its durable pending outcome
(or `prompt_failed` when it has none), so it never reports as `unknown` while a
record exists.

`unknown` means uncertainty, never proof of non-execution: do not reuse an
operation reference as a retry mechanism (`client_ref_conflict` while the
record is retained; after eviction a reused ref may be admitted again with the
prior outcome unknown). Use one fresh operation reference per logical prompt
and reconcile with `status`.

## Checkpoint gaps

`tail` reports a `retention_gap` when retained history or the event ring
dropped entries before the durable checkpoint: the gap carries the missing
sequence range (`missing.from`/`missing.to`) and a `resync` checkpoint.
`--strict` turns any gap into `retention_gap` with exit 1; without `--strict`,
tail continues from the resync position and reports the gap in the envelope.


## Migration from the removed daemon session route

`gjc daemon session` is removed and no alias is provided. Migrate:

| Removed route | Replacement |
| --- | --- |
| `gjc daemon session list` | `gjc sdk session list` |
| `gjc daemon session inspect <sessionId>` | `gjc sdk session inspect <sessionId>` |
| `gjc daemon session send <sessionId> --text <prompt>` | `gjc sdk session send <sessionId> --text <prompt>` |
| `gjc daemon session tail <sessionId>` | `gjc sdk session tail <sessionId>` |
| raw control/query dispatch | `gjc sdk session raw control|query|global` |

The broker-bound surface replaces the daemon-owned routing: sessions are
resolved through the SDK broker with validated endpoint identity instead of
direct discovery-file reads, and output is versioned and credential-free.

## Exit codes and error envelope

Verbs exit `0` on success and write JSON to stdout. Failures write a JSON error
envelope to stdout with a non-zero exit: usage errors exit `2`, operational
failures (broker unavailable, session unavailable, retention gap, wait
timeout) exit `1`. Error details are recursively redacted of secret-shaped
fields before rendering.

## Scoped search (`gjc sdk search`)

`gjc sdk search [--scope repo|pwd|global] [--limit N] [--cursor <token>] [--json]`
lists broker-visible sessions inside one exact scope. The default scope is
`repo`: the identical canonical Git worktree of the invoking directory, never a
path prefix or subtree. `pwd` matches the exact canonical working directory and
`global` covers every broker-visible row.

Every result — table and JSON, populated and empty — carries a scope/status
envelope: the requested scope, the canonical resolved scope, a status
(`populated`, `empty`, `not-in-git-worktree`, `unavailable`), and the
observation time. Running `--scope repo` outside a Git worktree is a successful
empty result (`not-in-git-worktree`, exit 0) and never falls back to `pwd` or
`global`. Broker unavailability keeps the locally resolved scope, exits
non-zero, and stays credential-free. Continuation cursors are frozen: a
continuation that supplies a different scope or anchor fails with
`scope_cursor_mismatch` instead of re-scoping.

Rows are probed only after scope filtering, through broker/router-owned
credential-free attachments, yielding `reachable`, `unreachable`, or `stale`.

## Local-only spawn (`gjc sdk spawn`)

`gjc sdk spawn --cwd <dir> --prompt <task> [--model <selector>] [--profile <name>] [--json]`
creates one task-seeded background child session through the broker. It is
legal only inside a live interactive `gjc --master` session: the command needs
the master's transient capability (threaded through the master session
environment) and the broker verifies it against the live effective master host
before any effect. Spawn is prohibited on MCP, ACP, daemon CLI/raw session CLI,
Telegram, Discord, and Slack surfaces.

Each invocation uses a fresh idempotency identity. One identity produces at
most one child substrate and one seed prompt; repeated requests replay the
stored outcome. A semantically new task requires a new invocation, never a
retry of an old identity. `spawn_in_progress` and `terminal_uncertain` are
honest durable states: inspect with `gjc sdk search` or session status instead
of retrying blindly.

The task text and master capability never persist anywhere in broker state —
no plaintext, hash, or derived verifier appears in the lifecycle ledger, spawn
authority journal, receipts, logs, or output. Spawn output renders only safe
fields: result code, claim id, child session id, substrate kind, and opaque
seed facts.

Close spawned children through the standard `session.close` path; the broker
closes only an exactly re-proven substrate and retains uncertainty on identity
mismatch. Children orphaned by confirmed master loss are reaped after
`sdk.masterOrphanGraceMs` (default 120000 ms, bounded 60000..3600000), with the
orphan clock preserved across broker restarts.
