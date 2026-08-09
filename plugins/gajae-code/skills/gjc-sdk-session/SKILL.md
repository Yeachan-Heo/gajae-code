---
name: gjc-sdk-session
description: Operate GJC SDK sessions from the CLI (`gjc sdk session list|inspect|send|status|tail|elevate|raw` plus the explicit raw control|query|global hatch). Advisory reference: broker-bound, credential-free output; mutating verbs run only when explicitly invoked.
---

# GJC SDK session CLI (advisory)

Advisory reference for interacting with live GJC SDK sessions through the
broker-bound `gjc sdk session` command family. This skill is informational:
it never prints endpoint credentials or changes configuration, and it never
references removed command routes. Mutating commands are only documented and
run when the operator explicitly invokes them.

## Broker authority

`list`, `inspect`, `send`, `status`, and `tail` resolve sessions through the
SDK broker. The broker validates the indexed session against its durable
endpoint record and hands the CLI a connection credential the CLI uses and
never prints. `--agent-dir` selects the broker state directory.

## Semantic verbs

- `gjc sdk session list` — broker `session.list` projected to the versioned,
  credential-free row DTO (session id, locator, pid, liveness, tombstone,
  activity, heartbeat, identity provenance, ambiguity).
- `gjc sdk session inspect <sessionId>` — one indexed row; when the broker is
  absent, falls back to a credential-free offline projection from the local
  endpoint discovery record.
- `gjc sdk session send <sessionId> --text <prompt>` — ordered `turn.prompt`
  carrying a caller-chosen operation reference (ULID). `--wait` polls
  `turn.prompt_status` until terminal or the wait window elapses; it never
  cancels a running turn.
- `gjc sdk session status <sessionId> <opRef>` — lossless `turn.prompt_status`
  for a previously submitted operation reference.
- `gjc sdk session tail <sessionId>` — retained transcript replay from the
  durable checkpoint followed by live event-ring frames. `--strict` fails
  closed on retention gaps, `--until-idle` exits at a terminal turn state,
  `--all-events` widens the emitted event kinds, and `--cursor` resumes from a
  saved checkpoint token that is re-minted per connection.
- `gjc sdk session elevate <sessionId> --kind <control|global> --op <operation> --json-input ... --confirm` — creates an exact-digest grant request and, only on an attended TTY, submits a private 0600 operator directive consumed by the broker. The returned request id is passed to an allowlisted raw control with `--elevation-request-id`.

## Raw hatch

`gjc sdk session raw control|query|global` dispatches one SDK operation with `--op`
(control/global) or `--query` (query) plus a JSON input source. Lifecycle
globals require `--idempotency-key`; destructive control operations accept
`--confirm`. Endpoint-disclosure operations are refused by default and stay
refused by this skill.

## Lossless prompt statuses

`turn.prompt_status` reports `accepted`, `in_flight`, `terminal_ok`, or
`failed`; only retained-record eviction yields `unknown`, which means
uncertainty, never proof of non-execution. Never reuse an operation reference
as a retry mechanism.

## Checkpoint gaps

`tail` reports a `retention_gap` with the missing sequence range and a
`resync` checkpoint when retained history or the event ring dropped entries;
`--strict` turns any gap into exit code 1.

## Elevation behavior

Elevation-gated operations are dispatched only behind broker-owned single-use
grants whose digest binds the exact operation and input. `elevate` is the
attended operator surface: it writes a private directive consumed inside the
broker; there is no public `elevation.answer` operation. A crash between claim
and dispatch is recorded truthfully as `consumed`/`uncertain` and requires a
new grant. Default SDK scope stays grant-free.
