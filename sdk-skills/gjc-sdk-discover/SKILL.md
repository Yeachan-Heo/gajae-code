---
name: gjc-sdk-discover
description: Discover and inspect trusted local GJC sessions through the broker-bound session CLI.
---

# GJC SDK session discovery

Use this skill when an external agent needs to find or inspect local GJC sessions without terminal scraping, MCP, or coordinator delegation.

## Required behavior

1. Resolve the repository root explicitly.
2. Run `gjc sdk session list --json` with that repository as the working directory and consume only its credential-free Broker DTO.
3. Select an exact session ID from that DTO, then use `gjc sdk session inspect <sessionId> --json` or the fixed raw-query commands below.
4. Fail closed for missing, unavailable, stale, dead, unknown, or ambiguous Broker results.
5. Never scan `.gjc/state/sdk`, parse endpoint records, read credentials, or open a raw per-session WebSocket.
6. Add `--json` explicitly to every machine CLI call: successful session JSON is unchanged, but default ordinary failures are text on stderr. Consume the single `gjc.command-error` version 1 stdout envelope on nonzero exit; never treat missing JSON as success or publish raw stderr. Usage exits 2; operation failures exit 1.

## Core inspection recipe

Compose this task-required pull-based view in order with `gjc sdk session raw query <sessionId> --query <query> --json`:

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

## Bounded discovery and failure evidence

Use inert local help, for example `gjc sdk session raw query --help --json`.
Sections are `overview|usage|children|arguments|options|examples|recovery`;
`--help-section <section> --help-page <N>` selects a page (default overview/1).
Follow returned `next.argv` with `--help-revision <sha256>` and `--json` intact.
`-h` is supported, `--help=json` is not; selectors require actual help, no
repeats and positive decimal safe-integer pages. Values and `--` cannot activate
help. Help lists only the local node/immediate children and performs no probes.

Help, ordinary errors and evidence pages are each at most 8192 UTF-8 bytes;
this does not bound or paginate successful query bodies. Preserve safe complete
references and outcome certainty. An uncertain result never proves non-execution.
Do not add probes or automatic retries/restarts/kills just to produce guidance;
never suggest `gjc daemon restart sdk` (daemon kinds are telegram/discord/slack).

Only when a failure advertises a verified retained continuation, retrieve it at
`gjc sdk` (or its original `gjc daemon` family) with `--error-ref <id>` and
`--error-sha256 <digest>`, optional `--error-page <N>` and
`--error-agent-dir <dir>`, plus `--json`. Use the returned argv, not placeholders.
Root retrieval is exclusive with help/operations; it never scans other roots or
reruns an operation. Retention is exactly 24 hours, non-sliding: at most 64
committed records, 1 MiB each and 16 MiB aggregate, plus one 1 MiB pending file
and one 4096-byte lock. Help/success does not initialize this store.

Disk, permissions, quota or publication failure may yield `complete: false`,
`evidence.status: "unavailable"`, `continuation: null`; preserve the original
certainty and warn against blind replay. Never fabricate a locator or promise
lossless retrieval without successful publication and an unexpired record.
Reassemble base64 fragments by contiguous byte offsets and verify length/SHA256
before decoding UTF-8/JSON. A fragment is not executable; text help's escaped
JSON display literals are not shell argv.
## Broker-bound references

- [SDK session CLI](../../../docs/sdk-session-cli.md)
- Canonical templates: `gjc-sdk-author/templates/direct-sdk.ts` and `direct-sdk.py`
