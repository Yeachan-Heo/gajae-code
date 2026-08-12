---
name: gjc-sdk-discover
description: Discover and inspect trusted local GJC sessions through the broker-bound session CLI.
---

# GJC SDK session discovery

Use this skill when an external agent needs to find or inspect local GJC sessions without terminal scraping, MCP, or coordinator delegation.

## Required behavior

1. Resolve the repository root explicitly.
2. Run `gjc sdk session list` with that repository as the working directory and consume only its credential-free Broker DTO.
3. Select an exact session ID from that DTO, then use `gjc sdk session inspect <sessionId>` or the fixed raw-query commands below.
4. Fail closed for missing, unavailable, stale, dead, unknown, or ambiguous Broker results.
5. Never scan `.gjc/state/sdk`, parse endpoint records, read credentials, or open a raw per-session WebSocket.
6. Render only bounded, redacted CLI JSON; discard raw CLI stderr.

## Core inspection recipe

Compose this pull-based view in order with `gjc sdk session raw query <sessionId> --query <query>`:

1. `session.metadata`
2. `context.get`
3. `goal.list/get`
4. `todo.list`
5. `workflow.gates.list`
6. `session.stats`

Fetch transcript pages and diffs only when the user's task requires them:

- `transcript.list` and `transcript.body`
- `diff.list_files`, `diff.list_hunks`, and `diff.read_hunk`

The reads are not an atomic snapshot. For every reported field, identify its source query and classify it as `confirmed`, `inferred`, `stale`, `unavailable`, or `unknown`. Preserve partial results when independent queries succeed; never invent a missing value.

## Broker-bound references

- [SDK session CLI](../../../docs/sdk-session-cli.md)
- Canonical templates: `gjc-sdk-author/templates/direct-sdk.ts` and `direct-sdk.py`
