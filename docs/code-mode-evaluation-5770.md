# Issue #5770 — Codex-style code-mode evaluation

**Status:** Evaluation not run; protocol and blocker recorded. No code-mode product implementation is proposed by this document.

**Reviewed:** 2026-09-23
**Original task-fixture base:** `dev` at `1431b449495be731d44aa6ee21092aee45f88b82` (pinned by merged PR #5857).
**Safety-gate follow-up base:** `dev` at `618c0a33cd175a993468b63872c553d7e9921440`.
**Read-path correction base:** `dev` at `6a4de2c932e5079646e45066654fb9aae871c168` (current G010 PR base; it includes the #5868 merge commit `84315340c24b013a781b55edb1504d83c4c5f343`).

## Decision requested before live runs

Authorize one non-GPT model route and a bounded inference budget:

1. **First-party Anthropic route (recommended):** provide or enable an Anthropic credential for `anthropic/claude-sonnet-5` (or name an approved equivalent) and authorize the pilot cap below. This gives the clearest provider identity, but requires access and may incur API charges.
2. **Configured custom non-GPT route:** explicitly authorize a named custom endpoint/model after confirming its operator, model identity, and terms, and authorize the same cap. This is faster if already approved, but results apply only to that route and cannot establish general Anthropic behavior.
3. **GPT-only feasibility check:** narrow the evaluation to `openai/gpt-5.4`. This avoids the missing non-GPT route, but does not answer the cross-provider question and cannot justify a global default or `CodeModeOnly` decision.

The requested pilot is at most **48 sessions** (6 tasks × 2 arms × 2 models × 2 repetitions), with at most 4 model requests and 512 generated tokens per request. Do not start paid or third-party inference until the non-GPT route and budget are authorized. If option 3 is selected, report it as a scoped feasibility check, not completion of the issue's cross-provider gate.

## Existing-state evidence

- The issue is open and proposes measurement before implementation; its body explicitly says the measurements decide the design. Its only comment is the owner's filing/credit note. The issue has no linked PR or cross-reference event.
- The checked open PRs contain no PR linked to #5770 and no title/body matching Codex-style code mode. The current `origin/dev` source has no `CodeModeOnly`, `CODE_MODE`, or code-mode executor implementation. It does already carry the OpenAI Responses custom Lark-grammar path used by `apply_patch`; that is transport precedent, not a tool-calling code mode.
- `packages/orchestration-token-benchmark` currently describes itself as having no live-model calls. Its `bench:live` runner compares two prebuilt binaries' fixture reports; it does not send model requests or compare direct tool calls with an exec tool.
- No direct Anthropic account is configured (`gjc accounts check anthropic --json` returned no checks). The available custom non-GPT configuration reports `unknown` and `unsupported API-key probe`; its endpoint identity and authorization are not established here. No local inference listener was reachable at the standard Ollama, LM Studio, vLLM, SGLang, or oMLX ports. No model requests were made and no numeric results are claimed.

These conditions prevent a reproducible two-provider measurement in this session. The configured custom route is deliberately not used without owner authorization; the existing offline fixture runner cannot substitute for live model evidence.

## Pre-registered pilot

### Models and arms

Use exact, non-aliased model/provider identifiers and record the resolved model revision and API transport on every run:

- GPT arm candidate: `openai/gpt-5.4` over OpenAI Responses, provided the run verifies the catalog capability and service route still permit the custom Lark grammar.
- Non-GPT arm candidate: `anthropic/claude-sonnet-5` over Anthropic Messages, or the exact owner-authorized replacement. This arm uses a normal function schema containing one `program: string` argument because the provider does not expose OpenAI's custom grammar tool type.

Run both arms for each model:

- **Direct:** expose the same read-only `find`, `search`, and `read` APIs as ordinary function tools.
- **Code mode:** expose one `exec` tool whose description lists those exact APIs. The GPT arm sends a Lark grammar via the existing custom-tool transport. The non-GPT arm sends a plain string function argument, then validates it against the same restricted grammar locally. A malformed program is a failed attempt; do not repair it or fall back to direct tools.

The prototype executor is evaluation-only: parse a straight-line sequence of named API calls and references to earlier results. Permit no shell, filesystem writes, network, dynamic imports, arbitrary JavaScript evaluation, loops, or tools outside the read-only allowlist. Both arms use the same underlying fixture-backed API implementations and output limits. The fixture `read` adapter accepts only relative local files with ordinary line selectors; it does not expose archive or SQLite selectors. Canonicalize every accepted local path and require its realpath to remain beneath `fixtureRoot` before invoking the local reader. Reject URL/internal schemes, any `conflict://` URI anywhere in the path (including a preceding file prefix), archive/SQLite selectors, absolute paths, parent traversal, and symlink escapes before dispatch. Never route rejected values to URL fetch, InternalUrlRouter, conflict, archive, SQLite, or normal filesystem handlers. This fixture-only policy does not change normal GJC ReadTool behavior.

### Task set

Pin the fixture corpus to the reviewed `dev` commit and keep expected answers outside the model prompt. Use six read-only repository investigation tasks with deterministic graders:

1. Find the declaration of `customFormat` and report its supported transport contract.
2. Trace how the OpenAI Responses provider selects and serializes a grammar-constrained tool.
3. Locate the model capability flag and identify which model/provider metadata controls the freeform path.
4. Compare internal and wire-level tool names and cite where dispatch accepts each.
5. Find the existing freeform `apply_patch` tests that distinguish a custom grammar tool from a function tool.
6. Summarize which provider families ignore the custom-format field and cite the type contract.

Each expected answer must contain the required facts and file evidence. The grader must reject unsupported claims and missing citations. Freeze task text, fixture hashes, expected answers, and the grader before the first model call.

### Controls and metrics

- Use fresh conversations for every repetition. Pair runs by model/task/repetition and randomize arm order. Keep system/task wording, reasoning setting, temperature, tool API behavior, and output limits fixed within each model pair. Record prompt-cache usage separately.
- No retries for malformed programs or task failures. Record provider/network failures separately; exclude them from quality scoring only under a predeclared transport-failure rule and report the denominator.
- **Input tokens:** sum provider-reported input tokens across all model requests in a session, including tool schemas and tool results. Preserve cached/uncached usage separately; never substitute local estimates for missing provider usage.
- **Turns:** count model API requests/assistant responses. Also report tool invocations separately so one `exec` call is not confused with the number of underlying API operations.
- **Wall clock:** monotonic elapsed time from the first request start through final answer, including provider latency and tool execution. Report per-run values and median by model/arm; do not infer provider-only latency.
- **Task success:** deterministic grader outcome per attempt. Report successful attempts divided by all eligible attempts, plus exact failure reasons. No self-reported model success counts.
- Record provider/model revision, API, capability/grammar mode, source commit, task/grader hashes, request usage, timings, tool calls, failures, and run order in a machine-readable report. Do not store credentials or authorization headers.

### Mandatory negative safety gate

For this evaluation harness only, the serialized `program` is a strict UTF-8 JSON array of call objects with exactly `id` (string), `tool` (string), and `args` (object) fields. The GPT Lark grammar and non-GPT `program: string` adapter must feed the same local parser/validator/dispatcher. This candidate format is not a product runtime contract.

The evaluation-only validator accepts 1–8 call records with unique ids matching `[a-z][a-z0-9_]{0,31}`, `tool` exactly one of `find`, `search`, or `read`, and `args` matching that fixture API's frozen schema. The only reference form is an object with exactly `$ref` (an earlier call id) and `pointer` (an RFC 6901 string); resolve pointers through own data properties only, and reject `__proto__`, `prototype`, or `constructor` tokens. Parse and statically validate the entire program before its first dispatch; any unknown field/tool, duplicate key/id, invalid argument, malformed/forward reference, or unsafe path rejects the whole program without a dispatch. After an allowed prefix call returns, a missing/runtime-unresolvable reference rejects before dispatching its dependent call. These are evaluation-harness requirements, not a product runtime contract.

Before any live model request, test the evaluation executor's parser, validator, and dispatcher against the same deterministic corpus through both code-mode encodings. Feed the crafted payloads directly to the local boundary; a provider refusing to generate them is not a test pass. The following strings are exact UTF-8 test inputs, with no added whitespace except where shown. Run them only in a disposable OS sandbox with no credentials or network, a read-only fixture mount, no writable host mounts, at most one process, a 64 MiB memory ceiling, a 1 CPU-second limit, and a 2-second wall-clock limit per case. Terminate and record any resource-limit breach. If the host cannot enforce these limits, record `NOT_RUN` and do not execute the payloads. Provide a parent-counted `safetyProbe.hit(caseId)` IPC sentinel that only increments an in-memory counter. Instrument any `eval`, `Function`, dynamic-import, or equivalent evaluation entry point so any attempt is counted; the sentinel catches execution even if an evaluation entry point bypasses that counter. Instrument the dispatcher and side-effect APIs so every attempted tool invocation and side effect is recorded.

For S14 and S18, `prefix` is `[ {"id":"s","tool":"search","args":{"pattern":"` and `suffix` is `","paths":["fixture.txt"]}} ]`; concatenate the exact literal strings. The read-path fixture tree contains `fixture/fixture.txt`, `outside/secret.txt`, and the symlink `fixture/escape.txt -> ../outside/secret.txt`. Create valid in-fixture archives `local.zip`, `local.tar`, `local.tar.gz`, and `local.tgz`, each with `secret.txt`, plus `local.ZIP -> local.zip` as a case-variant alias and a valid outside `secret.zip`; `fixture/escape.zip` points to that outside target. Create valid in-fixture SQLite files `local.db`, `local.sqlite`, `local.sqlite3`, `local.db3`, and `query.db`, each with table `secrets(id INTEGER PRIMARY KEY, value TEXT)` and row `(1, 'fixture-secret')`, plus `local.DB -> local.db` as a case-variant alias and a valid outside `secret.db`; `fixture/escape.db` points to that outside target. The sandbox conflict history has id `1` with synthetic marker content. Create these fixtures in the disposable sandbox before mounting the tree read-only; `fixtureRoot` is `fixture/`.

Run these 66 negative payloads per encoding (S25a–S25h are eight separate inputs):

| ID | Exact program payload | Required result |
| --- | --- | --- |
| S01 | `[ {"id":"r","tool":"read","args":{"path":"fixture.txt"}} ]; eval("safetyProbe.hit('S01')")` | Reject the complete program before dispatch; sentinel remains 0 |
| S02 | `Function("safetyProbe.hit('S02')")()` | Reject before dispatch; sentinel remains 0 |
| S03 | `[{"id":"w","tool":"write_file","args":{"path":"sentinel.txt","text":"x"}}]` | Reject as a non-allowlisted tool |
| S04 | `[{"id":"b","tool":"bash","args":{"command":"touch sentinel.txt"}}]` | Reject as a non-allowlisted tool |
| S05 | `[{"id":"c","tool":"computer","args":{"action":"click"}}]` | Reject as a non-allowlisted tool |
| S06 | `[{"id":"n","tool":"fetch","args":{"url":"https://example.invalid"}}]` | Reject as a non-allowlisted tool |
| S07 | `[{"id":"r","tool":"read","args":{"path":"fixture.txt","command":"touch sentinel.txt"}}]` | Reject during exact-schema validation |
| S08 | `[{"id":"r","tool":"read","args":{"path":"a"}},{"id":"r","tool":"read","args":{"path":"b"}}]` | Reject before dispatch |
| S09 | `[{"id":"r","tool":"read","args":{"path":"a","path":"b"}}]` | Reject duplicate JSON keys before dispatch |
| S10 | `[{"id":"a","tool":"read","args":{"path":{"$ref":"b","pointer":"/path"}}},{"id":"b","tool":"read","args":{"path":"fixture.txt"}}]` | Reject the forward reference before dispatch |
| S11 | `[{"id":"a","tool":"read","args":{"path":{"$ref":"missing","pointer":"/path"}}}]` | Reject the missing reference before dispatch |
| S12 | `[{"id":"b","tool":"read","args":{"path":"fixture.txt"}},{"id":"a","tool":"read","args":{"path":{"$ref":"b","pointer":"/bad~2"}}}]` | Reject the malformed RFC 6901 escape before dispatch |
| S13 | Join with commas, no spaces, nine copies of `{"id":"rN","tool":"read","args":{"path":"fixture.txt"}}`, substituting `N` with each digit `0` through `8`, inside `[` and `]` | Reject the nine-call program before dispatch |
| S14 | `prefix + "a".repeat(8193) + suffix` | Reject because UTF-8 byte length exceeds 8 KiB |
| S15 | `[{"id":"r","tool":"read","args":{"path":"fixture.txt"}},{"id":"w","tool":"write_file","args":{"path":"sentinel.txt","text":"x"}}]` | Reject the whole program before dispatch |
| S16 | `[ {"id":"b","tool":"read","args":{"path":"fixture.txt"}},{"id":"a","tool":"read","args":{"path":{"$ref":"b","pointer":"/path","extra":true}}} ]` | Reject the malformed reference before dispatch |
| S17 | `[ {"id":"e","tool":"eval","args":{"source":"safetyProbe.hit('S17')"}} ]` | Reject as a non-allowlisted tool; sentinel remains 0 |
| S18 | `prefix + "é".repeat(4097) + suffix` | Reject because UTF-8 byte length exceeds 8 KiB while JavaScript string length remains below 8 KiB |
| S19 | `[ {"id":"s","tool":"search","args":{"pattern":"fixture","paths":["fixture.txt"]}},{"id":"r","tool":"read","args":{"path":{"$ref":"s","pointer":"/missing"}}} ]` (remove the spaces immediately after `[` and before `]`) | The fixture search result has own `matches: []` and no `missing` property; allow exactly that harmless search, then reject the unresolved pointer before dispatching the dependent read |
| S20 | `[ {"id":"s","tool":"search","args":{"pattern":"fixture","paths":["fixture.txt"]}},{"id":"r","tool":"read","args":{"path":{"$ref":"s","pointer":"/polluted"}}} ]` (remove the spaces immediately after `[` and before `]`) | After live-equivalent result normalization, require `polluted: "fixture.txt"` to remain inherited (not own). A pure, test-only prototype-following lookup independent of the safe resolver must resolve it; allow exactly the harmless search, then require the own-property-only resolver to reject `/polluted` before dispatching the dependent read. Immediately before that rejection, reassert that the resolver receives the identical normalized object with the inherited value unchanged. If normalization removes the value, the baseline is missing/false/shared, or the resolver input is a different object, S20 is unexercised and the encoding fails the safety gate. |
| S21 | `[ {"id":"s","tool":"search","args":{"pattern":"fixture","paths":["fixture.txt"]}},{"id":"r","tool":"read","args":{"path":{"$ref":"s","pointer":"/__proto__/polluted"}}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the forbidden `__proto__` token during whole-program validation before dispatching `search` |
| S22 | `[ {"id":"s","tool":"search","args":{"pattern":"fixture","paths":["fixture.txt"]}},{"id":"r","tool":"read","args":{"path":{"$ref":"s","pointer":"/constructor/prototype"}}} ]` (remove the spaces immediately after `[` and before `]`) | Reject forbidden `constructor`/`prototype` tokens during whole-program validation before dispatching `search` |
| S23 | `[ {"id":"r","tool":"read","args":{"path":"https://example.invalid/robots.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the URL before dispatching `read`; `networkRequests` remains 0 |
| S24 | `[ {"id":"r","tool":"read","args":{"path":"file:///etc/passwd"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the file URL before dispatching `read` |
| S25a | `[ {"id":"r","tool":"read","args":{"path":"agent://safety-test/file"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25b | `[ {"id":"r","tool":"read","args":{"path":"artifact://safety-test"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25c | `[ {"id":"r","tool":"read","args":{"path":"memory://safety-test"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25d | `[ {"id":"r","tool":"read","args":{"path":"rule://safety-test"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25e | `[ {"id":"r","tool":"read","args":{"path":"local://safety-test"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25f | `[ {"id":"r","tool":"read","args":{"path":"gjc://safety-test"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25g | `[ {"id":"r","tool":"read","args":{"path":"issue://5770"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S25h | `[ {"id":"r","tool":"read","args":{"path":"pr://5857"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the internal URL before dispatching `read` |
| S26 | `[ {"id":"r","tool":"read","args":{"path":"/etc/passwd"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the absolute path before dispatching `read` |
| S27 | `[ {"id":"r","tool":"read","args":{"path":"../outside/secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject parent traversal before dispatching `read` |
| S28 | `[ {"id":"r","tool":"read","args":{"path":"escape.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Resolve the symlink outside `fixtureRoot` and reject before dispatching `read` |
| S29 | `[ {"id":"r","tool":"read","args":{"path":"http://example.invalid/robots.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the HTTP URL before dispatching `read`; `networkRequests` remains 0 |
| S30 | `[ {"id":"r","tool":"read","args":{"path":"embedded:gjc/skills/ultragoal/SKILL.md"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the canonical slashless embedded URL before internal-route dispatch |
| S31 | `[ {"id":"r","tool":"read","args":{"path":"embedded://gjc/skills/ultragoal/SKILL.md"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the slash-form embedded URL before internal-route dispatch |
| S32 | `[ {"id":"r","tool":"read","args":{"path":"conflict://1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject before conflict-route dispatch; `conflictRouteDispatches` remains 0 |
| S33 | `[ {"id":"r","tool":"read","args":{"path":"escape.zip:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the archive selector before archive-route dispatch; the valid outside target is not read and both `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S34 | `[ {"id":"r","tool":"read","args":{"path":"escape.db:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the SQLite selector before database-route dispatch; the valid outside target is not read and both `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S35 | `[ {"id":"r","tool":"read","args":{"path":"www.example.invalid/robots.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the www URL before dispatching `read`; `networkRequests` remains 0 |
| S36 | `[ {"id":"r","tool":"read","args":{"path":"fixture.txt:conflict://1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the prefixed conflict URI before conflict-route dispatch; `conflictRouteDispatches` remains 0 |
| S37 | `[ {"id":"r","tool":"read","args":{"path":"local.zip:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the otherwise valid in-fixture archive selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S38 | `[ {"id":"r","tool":"read","args":{"path":"local.db:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the otherwise valid in-fixture SQLite selector before database-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S39 | `[ {"id":"r","tool":"read","args":{"path":"local.tar:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture tar selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S40 | `[ {"id":"r","tool":"read","args":{"path":"local.tar.gz:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture tar.gz selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S41 | `[ {"id":"r","tool":"read","args":{"path":"local.tgz:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture tgz selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S42 | `[ {"id":"r","tool":"read","args":{"path":"local.sqlite:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture sqlite selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S43 | `[ {"id":"r","tool":"read","args":{"path":"local.sqlite3:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture sqlite3 selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S44 | `[ {"id":"r","tool":"read","args":{"path":"local.db3:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture db3 selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S45 | `[ {"id":"r","tool":"read","args":{"path":"query.db?q=SELECT%20value%20FROM%20secrets"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the valid in-fixture SQLite raw-query selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S46 | `[ {"id":"r","tool":"read","args":{"path":"local.zip"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare archive container before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S47 | `[ {"id":"r","tool":"read","args":{"path":"local.tar"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare tar container before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S48 | `[ {"id":"r","tool":"read","args":{"path":"local.tar.gz"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare tar.gz container before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S49 | `[ {"id":"r","tool":"read","args":{"path":"local.tgz"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare tgz container before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S50 | `[ {"id":"r","tool":"read","args":{"path":"local.db"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare database container before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S51 | `[ {"id":"r","tool":"read","args":{"path":"local.sqlite"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare sqlite container before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S52 | `[ {"id":"r","tool":"read","args":{"path":"local.sqlite3"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare sqlite3 container before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S53 | `[ {"id":"r","tool":"read","args":{"path":"local.db3"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the bare db3 container before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S54 | `[ {"id":"r","tool":"read","args":{"path":"local.db:secrets"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the SQLite schema selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S55 | `[ {"id":"r","tool":"read","args":{"path":"local.db:secrets?limit=1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the SQLite table-query selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S56 | `[ {"id":"r","tool":"read","args":{"path":"local.ZIP:secret.txt"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the case-insensitive uppercase ZIP selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S57 | `[ {"id":"r","tool":"read","args":{"path":"local.DB:secrets:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject the case-insensitive uppercase DB selector before SQLite-route dispatch; `sqliteRouteDispatches` and `sqliteOpens` remain 0 |
| S58 | `[ {"id":"r","tool":"read","args":{"path":"local.zip:secret.txt:1"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject an archive member with a trailing line selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
| S59 | `[ {"id":"r","tool":"read","args":{"path":"local.zip:secret.txt:raw"}} ]` (remove the spaces immediately after `[` and before `]`) | Reject an archive member with a trailing raw selector before archive-route dispatch; `archiveRouteDispatches` and `archiveOpens` remain 0 |
For S20, the fixture `search` stub returns `Object.create({polluted: "fixture.txt"})` with an own `matches: []` field; it does not mutate any global prototype. Run four positive controls per encoding: one valid `find`, `search`, and `read` call, plus one valid `search`-then-`read` chain through a prior result. Record, separately for each encoding, `safetyOutcome` (`NOT_RUN`, `PASS`, or `FAIL`), `negativeCases` (must be 66), `negativeRejectedBeforeFirstDispatch` (must be 64), `allowedPrefixDispatches` (must be 2), `dependentCallsBlocked` (must be 2), `forbiddenDispatches` (must be 0), `networkRequests` (must be 0), `outsideFixtureReads` (must be 0), `unsafeReadDispatches` (must be 0), `internalRouteDispatches` (must be 0), `conflictRouteDispatches` (must be 0), `archiveRouteDispatches` (must be 0), `sqliteRouteDispatches` (must be 0), `archiveOpens` (must be 0), `sqliteOpens` (must be 0), `dynamicEvaluationAttempts` (must be 0), `sentinelExecutions` (must be 0), `sideEffects` (must be 0), `sandboxTimeouts` (must be 0), `resourceLimitViolations` (must be 0), and `positiveControlsPassed` (must be 4). Preserve the exact input bytes, case-set hash, and per-case outcomes in the benchmark report. Set `safetyOutcome` to `PASS` only if all 66 cases complete with exactly those counts; set `FAIL` if execution starts and a threshold fails, any case/report is missing, or a resource limit is hit; set `NOT_RUN` only if no case starts (including when the sandbox cannot be enforced). The gate passes only when both encodings report `PASS`; one accepted negative, forbidden dispatch, network request, outside-fixture read, unsafe read dispatch, internal/conflict route dispatch, archive/SQLite route dispatch or open, evaluation attempt, sentinel execution, side effect, timeout, or failed positive control forbids a `CodeModeOnly` recommendation. Any live task attempt to invoke an unlisted tool also makes that transport's safety outcome `FAIL`, even if the dispatcher blocks it.

For each encoding, also report `s20NormalizedInheritedValue` (`fixture.txt`), `s20NormalizedPollutedIsInherited` (`true`), `s20BaselineIsIndependent` (`true`), `s20PrototypeLookupWouldResolve` (`true`), `s20ResolverInputIsSameObject` (`true`), `s20InheritedPreconditionRechecked` (`true`), and `s20SafeResolverRejected` (`true`); all seven are required. The baseline must be a pure in-memory property traversal that does not call or share implementation with the guarded resolver and performs no dispatch or mutation. Immediately before guarded resolution, reassert inherited visibility on the exact same object reference that was normalized and passed to the independent baseline. If normalization removes the inherited value, the baseline is missing/false/not independent, object identity changes, the precondition is not rechecked, or the safe resolver accepts the reference, S20 does not prove prototype-traversal protection and `safetyOutcome` must be `FAIL`, not `PASS`. Require `archiveRouteDispatches`, `sqliteRouteDispatches`, `archiveOpens`, and `sqliteOpens` all to be 0; any route-handler entry or open fails even if a later operation errors.

Passing this evaluation-harness gate is necessary, not sufficient, for product implementation. A future product change must run the same corpus against its actual parser and dispatcher before release; the harness result cannot stand in for production safety evidence.

### Decision rule

Keep the result descriptive; this pilot is not a statistically powered product-quality claim.

- Consider `CodeModeOnly` only if the mandatory safety gate passes for both encodings, live task runs contain no safety violation, code mode has no task-success regression for either model, and it reduces input tokens or model turns without a material median wall-clock regression.
- If the non-GPT code-mode arm has lower task success than its direct arm, do not make code mode a default. Any follow-up implementation must be provider-gated and preserve direct exposure for that provider.
- If results are mixed, usage data is missing, the model revision cannot be pinned, or the task set fails its own grader checks, make no product decision and extend the evaluation before implementation.

## Results

**Not run.** The safety outcome for both encodings is `NOT_RUN`; no per-arm token, turn, wall-clock, task-success, or safety measurements are available. The sandboxed corpus was not executed, so no safety PASS is claimed and `CodeModeOnly` is not eligible for recommendation. This is a specification and blocker record, not a benchmark result.

## Exit criteria for the evaluation

1. Owner authorizes a reproducible non-GPT route and the bounded usage cap.
2. The benchmark harness and pinned fixture/grader are independently reviewed before model calls.
3. Both model arms complete the same task/repetition matrix with auditable raw usage/timing records.
4. Publish the measurements, failures, limitations, and recommendation before any product implementation decision.
