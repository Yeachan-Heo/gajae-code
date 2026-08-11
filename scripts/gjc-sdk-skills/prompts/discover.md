---
name: gjc-sdk-discover
description: Discover and inspect trusted local GJC sessions through direct SDK v3 endpoints.
---

# GJC SDK session discovery

Use this skill when an external agent needs to find or inspect local GJC sessions without terminal scraping, MCP, or coordinator delegation.

## Required behavior

1. Resolve the repository root explicitly.
2. Read the local SDK discovery records under `<repo>/.gjc/state/sdk/` through the maintained SDK discovery API.
3. Select an exact session ID. Session omission is allowed only when exactly one live endpoint exists.
4. Fail closed for missing, malformed, stale, dead, unknown, symlinked, or ambiguous discovery.
5. Never print, persist, return, or place the endpoint token in logs, errors, source, config, environment examples, or shell history.
6. Close every SDK client in a `finally` block.

## Core inspection recipe

Compose this pull-based view in order:

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

## Direct client references

- TypeScript: `@gajae-code/coding-agent/sdk`
- Python: `gjc_sdk`
- Canonical templates: `gjc-sdk-author/templates/direct-sdk.ts` and `direct-sdk.py`
