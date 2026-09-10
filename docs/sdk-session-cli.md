# SDK session CLI

`gjc sdk session` is the broker-bound command family for operating live GJC SDK
sessions from the terminal. It replaces the removed `gjc daemon session` route.

The command family has six semantic verbs — `list`, `inspect`,
`send`, `status`, `tail`, and `retire` — plus the explicit `raw` hatch that dispatches one
SDK operation as `control`, `query`, or `global`.

The session CLI is advisory tooling over the SDK: every semantic verb resolves
sessions through the SDK broker, and output is rendered through a versioned,
credential-free DTO. Endpoint credentials are never printed.

## Command-local help

Discovery is static and inert for every public SDK and daemon parent, leaf and
alias; it does not initialize a broker, settings, transport or evidence store.
Use the deepest known command for its arguments, applicable options and risks:

```sh
gjc sdk session raw query --help --json
gjc daemon reload --help --help-section options --help-page 1
```

`-h` is equivalent to `--help`. Sections traverse in this fixed order:
`overview`, `usage`, `children`, `arguments`, `options`, `examples`, `recovery`.
The defaults are `overview` and page `1`; an empty section has a valid page 1.
Each response includes only the selected node and, in `children`, its immediate
children. Follow the returned `next.argv` unchanged, including
`--help-revision <sha256>`, section, page and `--json` when selected. A changed
revision requires a new traversal; do not merge pages from different revisions.

Valued selectors accept separate or `=` operands. Pages are positive decimal
safe integers. Repeated/invalid selectors, selectors without actual help, and
unknown descendants fail with usage exit 2 at the nearest known command.
`--help=json` is unsupported. Option values and tokens after `--` do not activate
help or JSON mode. Syntax containing `<placeholders>` is documentation, not a
ready-to-run recovery command.

Text and `gjc.command-help` version 1 JSON responses are each at most 8192 UTF-8
bytes including the newline. Text escapes controls and labels display literals;
never paste escaped display text as shell argv. Complete entries have stable
IDs. Oversized values use non-executable base64 fragments: concatenate contiguous
`offsetBytes` ranges, verify `totalBytes` and `sha256`, then decode the complete
UTF-8 JSON value. `sectionComplete` ends a section; only `documentComplete: true`
with `next: null` ends traversal. Help paging never reruns an operation.

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

The raw global `session.list` route remains unfiltered, and `inspect`, `send`,
`status`, `tail`, `retire`, and raw control/query behavior is unchanged.

For a process-isolated caller that needs bounded discovery, request exactly one
Broker page instead of the semantic all-pages list:

```sh
gjc sdk session raw global --op session.list --page --limit 20 \
  --agent-dir <agent-dir>
gjc sdk session raw global --op session.list --page --cursor <opaque-cursor> \
  --limit 20 --agent-dir <agent-dir>
```

`--page` preserves the Broker page envelope, including `indexSeq`, `warnings`,
the bounded `sessions` array, and the opaque `continuationCursor`. The cursor
is a snapshot continuation: pass it back unchanged, with the same `--limit`,
and never restart from the first page or locally slice an all-pages result.
Semantic `gjc sdk session list` remains the fully paginated, scope-filtered
operation.

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
  `session.delete`, `session.reconcile_uncertain`, `session.lookup`) require
  `--idempotency-key`.

`session.lookup` is a read-only reconciliation of a previously submitted
`session.create`. Reuse the caller request key and the same create target that
were retained before dispatch; GJC derives the Broker identity and fingerprint
inside the lifecycle boundary. It never calls `session.create` and never
replays session work:

```sh
gjc sdk session raw global --op session.lookup \
  --idempotency-key <create-request-key> \
  --json-input '{"cwd":"/absolute/path/to/repo"}' \
  --agent-dir <agent-dir>
```

The credential-free result identifies the original operation and request key.
`status: "found"` carries the canonical session result; `pending`,
`not_found`, `conflict`, `uncertain`, and `terminal` are distinct structured
outcomes and retain `certainty` and the recovery identity. A missing record is
not proof that the create did not execute, so callers must not resubmit solely
because lookup reports `not_found`. Reconciliation failures exit nonzero while
preserving the structured outcome in JSON.

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

Session verbs exit `0` and keep their existing successful JSON stdout contract,
including when `--json` is absent. **Machine callers must explicitly add
`--json` for machine-readable failures.** Ordinary failures otherwise write
bounded text to stderr only. With `--json`, failure writes exactly one
`gjc.command-error` version 1 envelope and newline to stdout, with empty stderr.
Both modes are limited to 8192 UTF-8 bytes including formatting and newline.
Usage errors exit `2`; operation failures (including unavailable broker/session,
retention gaps and wait timeouts) exit `1`.

The envelope preserves `command`, `error.code`, `category`, `retryability`,
`outcomeCertainty`, allowlisted `references` and evidence-based `nextSteps`, plus
`omittedOptional`, `complete`, `evidence` and `continuation`. Safe fields are
explicitly projected; arbitrary exception messages, request bodies, credentials
and stacks are not public error evidence. Do not infer non-execution from a
nonzero exit or timeout: `wait_timeout` after acceptance means applied work,
whereas `uncertain_after_send` means the outcome is unknown. Preserve session,
operation, idempotency, claim, command and turn references when supplied.

Error guidance performs no additional probes, status calls, retries, restarts or
kills. Execute an appropriate explicit observation only when the task warrants
it; reconcile before considering replay. `retire` is a proof-bound mutation,
not a generic status check, and requires confirmed intent and actual applicable
proof. Daemon `stop`/`restart` interrupt work; `--force` permits SIGKILL escalation.
Daemon kinds are `telegram`, `discord`, `slack` (default `telegram`); `daemon`
defaults to `status`, and `reload` aliases `restart`. There is no
`gjc daemon restart sdk` recovery command. Never repeat successful mutations
when a multi-target daemon result contains failures.

### Retained error evidence

When essential sanitized reconciliation references do not fit inline, the CLI
may retain them locally, but advertises `evidence.status: "retained"` and a
continuation only after successful publication and read-back verification.
Retrieval is an explicit family-root operation, not an operation retry:

```text
gjc sdk --error-ref <32-lowercase-hex-id> --error-sha256 <64-lowercase-hex> [--error-page <N>] [--error-agent-dir <dir>] [--json]
gjc daemon --error-ref <32-lowercase-hex-id> --error-sha256 <64-lowercase-hex> [--error-page <N>] [--error-agent-dir <dir>] [--json]
```

Use the actual returned argv rather than constructing a locator. Ref and digest
are required together; page defaults to 1 and is a positive decimal safe integer.
Selectors support separate/equals forms; duplicates are invalid. Retrieval is
exclusive with help, operation positionals and operation flags. Scope/page
selectors require retrieval. `--error-agent-dir` is distinct from SDK operation
`--agent-dir`; daemon worker `--agent-dir` is private. Retrieval uses only the
explicit/default root and checks the stored family, never scans other roots.

The store is `<effective-agent-dir>/cli-error-evidence-v1`. Records expire exactly
24 hours after creation, without sliding reads. Expiry refuses retrieval; lazy
cleanup is not a promise of immediate secure erasure. Limits are 64 committed
records, 1 MiB per record and 16 MiB committed aggregate, plus at most one 1 MiB
pending file and one 4096-byte lock: at most 66 files and 17 MiB + 4096 bytes of
logical payload (filesystem allocation overhead is separate). Unexpired records
are not evicted to make space. POSIX owner-only permissions are verified; an
unsupported secure permission mechanism fails closed. No success/help output
initializes the store and there is no background cleanup service.

Successful retrieval is `gjc.command-error-evidence` version 1 on stdout, exit 0,
with each text/JSON page bounded to 8192 bytes. It means retrieval succeeded, not
that the original operation did. Follow the pinned digest/scope/mode continuation;
reassemble contiguous base64 bytes and verify total length and SHA256 before
UTF-8/JSON decoding or using references. Pages contain immutable retained evidence,
not resampled runtime state.

Disk, permissions, quota, lock contention or verification failure may prevent
retention. The original failure remains nonzero with its original outcome
certainty and retryability: `complete: false`, `evidence.status: "unavailable"`,
and `continuation: null`, with the explicit warning that necessary evidence
could not be retained and **do not blindly retry the original operation**.
Missing essential evidence is not described as optional, and no invented path,
ID, digest or fallback store is advertised. Lossless retrieval is guaranteed only
for successfully published records within their retention lifetime; expiry,
deletion or corruption can make later retrieval unavailable.

These bounds do not paginate successful session/search/spawn/guides results.
Search outside Git retains its successful exit-0 result; observing an unhealthy
daemon is still a successful status operation. Serve preflight errors use the
ordinary failure contract; after relay ownership, protocol framing and termination
remain unchanged, without CLI error envelopes injected into the stream.

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
