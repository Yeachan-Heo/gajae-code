# SDK session CLI

`gjc sdk session` is the broker-bound command family for operating live GJC SDK
sessions from the terminal. It replaces the removed `gjc daemon session` route
(no alias is kept). The command family has five semantic verbs — `list`, `inspect`,
`send`, `status`, and `tail` — plus the explicit `raw` hatch that dispatches one
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

- `sessionId` and the `locator` (`repo`, `stateRoot`);
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
- `--until-idle` exits once the observed event stream reaches a terminal turn
  state.
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

## Raw hatch

`gjc sdk session raw <control|query|global>` dispatches exactly one SDK
operation and returns the broker/host response:

- `raw control <sessionId> --op <operation>` — one control operation with
  `--json-input*`; `--confirm` confirms destructive control operations.
- `raw query <sessionId> --query <operation>` — one query; `--cursor` passes a
  continuation cursor.
- `raw global --op <operation>` — one broker global. Lifecycle globals
  (`session.create`, `session.fork`, `session.resume`, `session.close`,
  `session.delete`) require `--idempotency-key`.

`session.get_endpoint` is refused unconditionally: endpoint credentials remain
an SDK-core implementation detail. The raw hatch validates operation names and
adapter dispositions up front and never renders endpoint-disclosure results.

## Lossless prompt results

`turn.result` with `kind: "prompt"` reports `accepted`, `in_flight`,
`terminal_ok`, or `failed`; only retained-record TTL/capacity eviction yields
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
