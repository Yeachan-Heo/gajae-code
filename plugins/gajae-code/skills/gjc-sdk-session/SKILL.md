---
name: gjc-sdk-session
description: Operate GJC SDK sessions from the CLI (`gjc sdk session list|inspect|send|status|tail|raw` plus the explicit raw control|query|global hatch). Advisory reference: broker-bound, credential-free output; mutating verbs run only when explicitly invoked.
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
  `turn.result` with `kind: "prompt"` until terminal or the wait window elapses;
  it never cancels a running turn.
- `gjc sdk session status <sessionId> <opRef>` — lossless `turn.result` with
  `kind: "prompt"` for a previously submitted operation reference.

- `gjc sdk session tail <sessionId>` — retained transcript replay from the
  durable checkpoint followed by live event-ring frames. `--strict` fails
  closed on retention gaps, `--until-idle` exits at a terminal turn state,
  `--all-events` widens the emitted event kinds, and `--cursor` resumes from a
  saved checkpoint token that is re-minted per connection.

## Raw hatch

`gjc sdk session raw control|query|global` dispatches one SDK operation with `--op`
(control/global) or `--query` (query) plus a JSON input source. Lifecycle
globals require `--idempotency-key`; destructive control operations accept
`--confirm`. Endpoint-disclosure operations are refused by default and stay
refused by this skill.

## Lossless prompt results

`turn.result` with `kind: "prompt"` reports `accepted`, `in_flight`,
`terminal_ok`, or `failed`; only retained-record eviction yields `unknown`,
which means uncertainty, never proof of non-execution. `turn.prompt_status`
remains a legacy prompt-only alias. Never reuse an operation reference as a retry
mechanism.

## Checkpoint gaps

`tail` reports a `retention_gap` with the missing sequence range and a
`resync` checkpoint when retained history or the event ring dropped entries;
`--strict` turns any gap into exit code 1.
