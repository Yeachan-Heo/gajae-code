# JetBrains Air ACP smoke checklist

> **Human gate only.** A tester must complete this checklist manually for the
> recorded versions. CI and other automation must not auto-fill it. Attach only
> redacted logs; never attach tokens, credentials, prompts containing sensitive
> data, or unredacted endpoint discovery files.

## Test record

| Field | Value |
| --- | --- |
| Air product version/build | |
| GJC version/build/commit | |
| OS / architecture | |
| Exact ACP command | |
| `sdk.promptDeadlineMs` override used | |
| Timestamp (UTC) | |
| Tester | |

## Scenarios

Mark each scenario **Pass** or **Fail** and record concise, redacted evidence.

| Scenario | Pass / Fail | Redacted evidence / notes |
| --- | --- | --- |
| Initialize → session/new → prompt → streamed updates → `end_turn` | | |
| Cancellation → `cancelled` | | |
| Controlled failure → JSON-RPC `-32603` / `prompt_failed` | | |
| Controlled short deadline → JSON-RPC `-32603` / `prompt_deadline_exceeded` | | |
| Stale-endpoint restart guidance | | |

## Sign-off

| Field | Value |
| --- | --- |
| Overall result | |
| Redacted log attachment locations | |
| Known limitations or follow-up | |
